import {
	type AnalysisReport,
	analysisReportSchema,
	DOMAINS,
	type Domain,
	heartbeatSchema,
	type Resource,
} from "@nocoo/giraffe-agent/contracts";
import { apiGet } from "../lib/api";
import { ensureSession, getActiveAccountId } from "./session";

export type CurrentSource = {
	resource: string;
	version: string | null;
	fetchedAt: string | null;
	freshness?: unknown;
	coverage?: unknown;
	truncated: boolean;
	unavailable: boolean;
};
export type AnalysisData = {
	account_id: string;
	reports: Resource[];
	records: Resource[];
	jobs: Resource[];
	sources: CurrentSource[];
	repositories: string[];
};
export const DOMAIN_LABEL: Record<Domain, string> = {
	issues: "Issues",
	prs: "Pull Requests",
	ci: "CI 构建",
	cd: "CD 交付",
};
export const VERDICT_LABEL = {
	pass: "通过",
	attention: "需关注",
	fail: "有问题",
	unknown: "证据不足",
};
export const STALE_MS = 36 * 3600000;
function aged(at: string | null, now: number) {
	const time = at ? Date.parse(at) : NaN;
	return !Number.isFinite(time) || now - time > STALE_MS || time > now + 60000;
}
export function sourceQuality(
	report: AnalysisReport,
	sources: CurrentSource[],
	now: number,
	repoReports: AnalysisReport[] = [],
	expectedRepositories?: string[],
) {
	let current = report.sources.length > 0,
		complete = current,
		stale = !current;
	const accountSources =
		report.scope === "global" &&
		report.sources.length > 0 &&
		report.sources.every((source) => source.resource.startsWith("account:"));
	if (report.scope === "global" && !accountSources && expectedRepositories) {
		const names = report.sources.map((source) => source.resource).sort();
		current = JSON.stringify(names) === JSON.stringify([...expectedRepositories].sort());
		complete &&= current;
	}
	const times: string[] = [];
	for (const source of report.sources) {
		if (source.fetchedAt) times.push(source.fetchedAt);
		stale ||= aged(source.fetchedAt, now);
		complete &&= source.complete;
		if (report.scope === "global" && !accountSources) {
			const child = repoReports.find(
				(r) => r.repository === source.resource && r.domain === report.domain,
			);
			current &&=
				!!child &&
				child.sourceVersion === source.version &&
				Date.parse(child.generatedAt) <= Date.parse(report.generatedAt);
			if (child) {
				const quality = sourceQuality(child, sources, now);
				current &&= quality.current;
				complete &&= quality.complete;
				stale ||= quality.stale;
			} else complete = false;
		} else {
			const saved = sources.find((s) => s.resource === source.resource);
			current &&= !!saved && saved.version === source.version;
			const freshness = saved?.freshness as { missing?: number } | null | undefined;
			complete &&= !!saved && !saved.truncated && !saved.unavailable && !freshness?.missing;
		}
	}
	return {
		current,
		complete,
		stale,
		oldestAt: times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
	};
}
export function runnerState(row: Resource, now: number) {
	const parsed = heartbeatSchema.safeParse(row.payload);
	if (!parsed.success) return null;
	const p = parsed.data;
	const age = now - Date.parse(p.lastSeenAt);
	return { ...p, online: age >= -60000 && age <= 90000 && !["offline", "error"].includes(p.state) };
}
export function safeEvidenceUrl(value: string | null) {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}
export function analysisState(data: AnalysisData, repository: string | null, now: number) {
	const errors: string[] = [];
	const reports: AnalysisReport[] = [];
	for (const row of data.reports) {
		const parsed = analysisReportSchema.safeParse(row.payload);
		if (
			!parsed.success ||
			parsed.data.repository !== row.repository ||
			parsed.data.sourceVersion !== row.source_version ||
			(parsed.data.scope === "repo") !== (row.repository !== null)
		) {
			errors.push(`报告 ${row.id} 格式或来源不匹配`);
			continue;
		}
		if (row.status === "completed") reports.push(parsed.data);
	}
	const repoReports = reports
		.filter((r) => r.scope === "repo")
		.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
	const bestRepos = repoReports.filter(
		(r, i, all) =>
			i === all.findIndex((x) => x.repository === r.repository && x.domain === r.domain),
	);
	const cards = DOMAINS.map((domain) => {
		const matches = reports
			.filter((r) => r.domain === domain && r.repository === repository)
			.map((report) => ({
				report,
				quality: sourceQuality(report, data.sources, now, bestRepos, data.repositories),
			}))
			.sort(
				(a, b) =>
					Number(b.quality.current) - Number(a.quality.current) ||
					b.report.generatedAt.localeCompare(a.report.generatedAt),
			);
		const best = matches[0];
		return {
			domain,
			report: best?.report ?? null,
			verdict:
				best?.quality.current && best.quality.complete && !best.quality.stale
					? best.report.verdict
					: ("unknown" as const),
			quality: best?.quality ?? { current: false, complete: false, stale: true, oldestAt: null },
		};
	});
	const runners = data.records
		.filter((r) => r.type === "heartbeat")
		.flatMap((row) => {
			const runner = runnerState(row, now);
			if (!runner) {
				errors.push(`心跳 ${row.id} 格式无效`);
				return [];
			}
			return [runner];
		});
	const jobs = data.jobs
		.filter((j) => ["analysis-request", "github-analysis"].includes(j.type))
		.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
	return { cards, runners, jobs, errors };
}
async function allPages(account: string, collection: string, type?: string) {
	const items: Resource[] = [];
	let cursor: string | null = null;
	const seen = new Set<string>();
	for (let i = 0; i < 50; i++) {
		const params = new URLSearchParams({
			limit: "100",
			...(type ? { type } : {}),
			...(cursor ? { cursor } : {}),
		});
		const result = await apiGet<{
			account_id: string;
			items: Resource[];
			nextCursor: string | null;
		}>(`agent/accounts/${account}/${collection}?${params}`);
		if (result.account_id !== account || getActiveAccountId() !== account)
			throw new Error("Account changed");
		items.push(...result.items);
		if (!result.nextCursor) return items;
		if (seen.has(result.nextCursor)) throw new Error("Invalid pagination");
		seen.add(result.nextCursor);
		cursor = result.nextCursor;
	}
	throw new Error("Too many resources; narrow retention before loading");
}
export async function loadAnalysis(): Promise<AnalysisData> {
	const account = await ensureSession();
	const [reports, records, jobs, sources] = await Promise.all([
		allPages(account, "reports", "github-analysis"),
		allPages(account, "records", "heartbeat"),
		allPages(account, "jobs"),
		apiGet<{ account_id: string; sources: CurrentSource[]; repositories: string[] }>(
			`agent/accounts/${account}/sources`,
		),
	]);
	if (sources.account_id !== account || getActiveAccountId() !== account)
		throw new Error("Account changed");
	return {
		account_id: account,
		reports,
		records,
		jobs,
		sources: sources.sources,
		repositories: sources.repositories,
	};
}
