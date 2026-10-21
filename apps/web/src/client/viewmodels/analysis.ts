import {
	type AnalysisReport,
	analysisReportSchema,
	DOMAINS,
	type Domain,
	type Resource,
} from "../../lib/analysis-contracts";
import { apiGet } from "../lib/api";
import { ensureSession, getActiveAccountId } from "./session";

export type CurrentSource = {
	resource: string;
	version: string | null;
	contentVersion?: string | null;
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
const botRunSchema = z
	.object({
		lastRunAt: z.string().datetime({ offset: true }),
		status: z.enum(["running", "completed", "failed"]),
		analyzed: z.number().int().nonnegative(),
		skipped: z.number().int().nonnegative(),
		error: z.string().optional(),
	})
	.strict();
function aged(at: string | null, now: number) {
	const time = at ? Date.parse(at) : NaN;
	return !Number.isFinite(time) || now - time > STALE_MS || time > now + 60000;
}

function generationTime(at: string) {
	const utc = at.endsWith("Z");
	const zone = at.slice(-6);
	const offset = utc
		? 0
		: (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * 60000 * (zone[0] === "+" ? 1 : -1);
	return {
		second: Date.parse(`${at.slice(0, 19)}Z`) - offset,
		fraction: at[19] === "." ? at.slice(20, utc ? -1 : -6).replace(/0+$/, "") : "",
	};
}

function compareGeneration(left: string, right: string) {
	const a = generationTime(left);
	const b = generationTime(right);
	if (a.second !== b.second) return a.second - b.second;
	return a.fraction === b.fraction ? 0 : a.fraction < b.fraction ? -1 : 1;
}

function newestReport(
	a: { id: string; report: AnalysisReport },
	b: { id: string; report: AnalysisReport },
) {
	return (
		compareGeneration(b.report.generatedAt, a.report.generatedAt) ||
		(a.id === b.id ? 0 : a.id < b.id ? 1 : -1)
	);
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
		complete &&= source.complete;
		if (report.scope === "global" && !accountSources) {
			if (source.fetchedAt) times.push(source.fetchedAt);
			stale ||= aged(source.fetchedAt, now);
			const child = repoReports.find(
				(r) => r.repository === source.resource && r.domain === report.domain,
			);
			current &&=
				!!child &&
				child.sourceVersion === source.version &&
				compareGeneration(child.generatedAt, report.generatedAt) <= 0;
			if (child) {
				const quality = sourceQuality(child, sources, now);
				current &&= quality.current;
				complete &&= quality.complete;
				stale ||= quality.stale;
			} else complete = false;
		} else {
			const saved = sources.find((s) => s.resource === source.resource);
			current &&=
				!!saved &&
				(source.contentVersion !== undefined && saved.contentVersion != null
					? saved.contentVersion === source.contentVersion
					: saved.version === source.version);
			if (saved?.fetchedAt) times.push(saved.fetchedAt);
			stale ||= aged(saved?.fetchedAt ?? null, now);
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
	const reports: { id: string; report: AnalysisReport }[] = [];
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
		if (row.status === "completed") reports.push({ id: row.id, report: parsed.data });
	}
	const repoReports = reports
		.filter(({ report }) => report.scope === "repo")
		.sort(newestReport)
		.map(({ report }) => report);
	const bestRepos = repoReports.filter(
		(r, i, all) =>
			i === all.findIndex((x) => x.repository === r.repository && x.domain === r.domain),
	);
	const cards = DOMAINS.map((domain) => {
		const matches = reports
			.filter(({ report }) => report.domain === domain && report.repository === repository)
			.map(({ id, report }) => ({
				id,
				report,
				quality: sourceQuality(report, data.sources, now, bestRepos, data.repositories),
			}))
			.sort((a, b) => Number(b.quality.current) - Number(a.quality.current) || newestReport(a, b));
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
	const record = data.records.find(
		(row) => row.id === "grok-bot-run" && row.type === "grok-bot-run",
	);
	let lastRun: (z.infer<typeof botRunSchema> & { stale: boolean }) | null = null;
	if (record) {
		const parsed = botRunSchema.safeParse(record.payload);
		if (
			!parsed.success ||
			record.repository !== null ||
			record.status !== parsed.data.status ||
			Date.parse(parsed.data.lastRunAt) > now + 60000
		) {
			errors.push("分析运行记录格式或状态无效");
		} else {
			lastRun = { ...parsed.data, stale: now - Date.parse(parsed.data.lastRunAt) > 48 * 3600000 };
		}
	}
	return { cards, lastRun, errors };
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
	const [reports, records, sources] = await Promise.all([
		apiGet<{ account_id: string; items: Resource[] }>(`agent/accounts/${account}/analysis/reports`),
		allPages(account, "records", "grok-bot-run"),
		apiGet<{ account_id: string; sources: CurrentSource[]; repositories: string[] }>(
			`agent/accounts/${account}/sources`,
		),
	]);
	if (
		reports.account_id !== account ||
		sources.account_id !== account ||
		getActiveAccountId() !== account
	)
		throw new Error("Account changed");
	return {
		account_id: account,
		reports: reports.items,
		records,
		sources: sources.sources,
		repositories: sources.repositories,
	};
}

import { z } from "zod";
