import { createHash } from "node:crypto";
import { ApiError, type GiraffeClient } from "./client.ts";
import type {
	AnalysisReport,
	Domain,
	Evidence,
	Observation,
	Resource,
	Source,
} from "./contracts.ts";
import { analysisReportSchema, repositorySchema } from "./contracts.ts";

export type AnalysisInput = {
	scope: "repo" | "global";
	repository: string | null;
	domain: Domain;
	sourceVersion: string;
	observedAt: string;
	sources: Source[];
	evidence: Evidence[];
	omitted: number;
	counts: Record<string, number>;
	limitations: string[];
};
export const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const rows = (value: unknown) => (Array.isArray(value) ? value.map(object) : []);
export const STALE_MS = 36 * 60 * 60 * 1000;
const MAX_EVIDENCE = 24;

export function ownedRepositories(catalog: Observation, login: string): string[] {
	if (catalog.unavailable || catalog.truncated)
		throw new Error("Repository inventory is incomplete; analysis scope cannot be established.");
	return rows(catalog.data.repos)
		.filter(
			(repo) =>
				text(repo.owner_login).toLowerCase() === login.toLowerCase() &&
				repo.is_archived !== true &&
				repo.is_fork !== true &&
				text(repo.name_with_owner).toLowerCase() !== "nocoo/rsshub",
		)
		.map((repo) => repositorySchema.parse(repo.name_with_owner))
		.sort();
}

function reference(observation: Observation, now: string): Source {
	const freshness = object(observation.freshness);
	const fetchedAt = text(freshness.oldestAt) || observation.fetchedAt || null;
	const valid = fetchedAt !== null && Number.isFinite(Date.parse(fetchedAt));
	const fetchedTime = fetchedAt === null ? NaN : Date.parse(fetchedAt);
	const complete =
		!observation.unavailable &&
		!observation.truncated &&
		Number(freshness.missing ?? 0) === 0 &&
		observation.data.forbidden !== true &&
		observation.data.unavailable !== true;
	return {
		resource: observation.source.resource,
		version: observation.sourceVersion,
		fetchedAt,
		complete,
		stale:
			!valid || Date.parse(now) - fetchedTime > STALE_MS || fetchedTime > Date.parse(now) + 60000,
	};
}

function evidenceOf(row: Record<string, unknown>, kind: string, repository: string): Evidence {
	const rawUrl = text(row.url ?? row.html_url);
	let url: string | null = null;
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol === "https:" && parsed.hostname === "github.com") url = parsed.toString();
	} catch {}
	const identity = String(row.number ?? row.id ?? digest(row).slice(0, 12));
	const detail = [
		row.body,
		row.review_decision,
		row.is_draft === true ? "Draft" : "",
		row.conclusion,
		row.head_branch,
		row.event,
		row.base_ref,
		row.head_ref,
		rows(row.labels)
			.map((label) => text(label.name))
			.join(", "),
		row.comments_count === undefined ? "" : `comments=${String(row.comments_count)}`,
		row.closedAt ? `closedAt=${String(row.closedAt)}` : "",
		row.mergedAt ? `mergedAt=${String(row.mergedAt)}` : "",
	]
		.map(text)
		.filter(Boolean)
		.join("; ")
		.slice(0, 900);
	return {
		id: `${repository}:${kind}:${identity}`.slice(0, 256),
		repository,
		kind,
		title: text(row.title ?? row.name ?? row.tag_name).slice(0, 300),
		state:
			text(row.state ?? row.status) ||
			(kind === "issues" || kind === "prs"
				? "open"
				: kind === "releases"
					? "published"
					: "unknown"),
		detail,
		url,
		at:
			text(row.updated_at ?? row.updatedAt ?? row.at ?? row.created_at ?? row.published_at) || null,
	};
}

export function buildInput(
	repository: string,
	domain: Domain,
	observations: (Observation | Source)[],
	now: string,
): AnalysisInput {
	const sources: Source[] = [];
	const evidence: Evidence[] = [];
	const counts: Record<string, number> = {};
	const limitations = new Set<string>();
	for (const observation of observations) {
		if (!("data" in observation)) {
			sources.push(observation);
			limitations.add(`Missing saved source: ${observation.resource}`);
			continue;
		}
		const source = reference(observation, now);
		const coverage = object(observation.coverage);
		if (typeof coverage.status === "string" && coverage.status !== "complete")
			source.complete = false;
		sources.push(source);
		if (!source.complete) limitations.add(`Incomplete source: ${source.resource}`);
		if (source.stale) limitations.add(`Stale or undated source: ${source.resource}`);
		const data = observation.data;
		const sourceDescription = `Source=${source.resource}; observedAt=${source.fetchedAt ?? "unknown"}. `;
		if (typeof data.default_branch === "string")
			limitations.add(
				`Default branch observed: ${data.default_branch}. Workflow names indicate roles heuristically only.`,
			);
		let kind: string;
		let items: Record<string, unknown>[];
		if (Array.isArray(data.issues)) {
			kind = "issues";
			items = rows(data.issues);
		} else if (Array.isArray(data.pull_requests)) {
			kind = "prs";
			items = rows(data.pull_requests);
		} else if (Array.isArray(data.runs)) {
			kind = "actions";
			items = rows(data.runs);
		} else if (Array.isArray(data.releases)) {
			kind = "releases";
			items = rows(data.releases);
		} else if (Array.isArray(data.items)) {
			kind = `${domain}-history`;
			items = rows(data.items);
		} else continue;
		counts[`${kind}.total`] = items.length;
		if (kind === "actions") {
			const latest = new Map<string, Record<string, unknown>>();
			for (const item of [...items].sort((a, b) =>
				text(b.created_at).localeCompare(text(a.created_at)),
			)) {
				const key = `${text(item.name)}:${text(item.head_branch)}`;
				if (!latest.has(key)) latest.set(key, item);
			}
			for (const item of latest.values()) {
				const state = text(item.conclusion) || "pending";
				counts[`latest-workflows.${state}`] = (counts[`latest-workflows.${state}`] ?? 0) + 1;
				evidence.push({
					...evidenceOf(item, "latest-workflow", repository),
					detail: `${sourceDescription}${evidenceOf(item, kind, repository).detail}`.slice(0, 900),
				});
			}
		}
		for (const item of items) {
			const state =
				text(item.conclusion ?? item.state ?? item.status) ||
				(kind === "issues" || kind === "prs" ? "open" : "unknown");
			counts[`${kind}.${state}`] = (counts[`${kind}.${state}`] ?? 0) + 1;
			const mapped = evidenceOf(item, kind, repository);
			evidence.push({ ...mapped, detail: `${sourceDescription}${mapped.detail}`.slice(0, 900) });
		}
	}
	evidence.sort((a, b) => {
		const risk = (item: Evidence) =>
			item.kind === "latest-workflow"
				? 4
				: item.state === "open"
					? 3
					: /failure|timed_out|action_required/.test(item.detail)
						? 2
						: 0;
		return risk(b) - risk(a) || (b.at ?? "").localeCompare(a.at ?? "");
	});
	if (domain === "issues" || domain === "prs")
		limitations.add(
			"Saved lists omit full discussion and changes; history excerpts are bounded, not a full event timeline.",
		);
	if (domain === "prs" || domain === "ci")
		limitations.add(
			"Saved evidence does not establish current head SHA, required checks, branch protection or merge eligibility.",
		);
	if (domain === "cd")
		limitations.add(
			"Release and workflow observations do not prove deployment revision or live environment health.",
		);
	const omitted = Math.max(0, evidence.length - MAX_EVIDENCE);
	if (omitted)
		limitations.add(
			`${omitted} evidence records omitted; aggregate counts retain observed totals.`,
		);
	return {
		scope: "repo",
		repository,
		domain,
		sourceVersion: digest({ repository, domain, sources }),
		observedAt: now,
		sources,
		evidence: evidence.slice(0, MAX_EVIDENCE),
		omitted,
		counts,
		limitations: [...limitations],
	};
}

export async function collectInput(
	client: GiraffeClient,
	repository: string,
	domain: Domain,
	now: string,
	signal?: AbortSignal,
): Promise<AnalysisInput> {
	repositorySchema.parse(repository);
	const repo = repository.split("/").map(encodeURIComponent).join("/");
	const paths =
		domain === "issues" || domain === "prs"
			? [`repos/${repo}/${domain}`, `factory/repos/${repo}/${domain}`]
			: domain === "ci"
				? [`repos/${repo}/actions`, `repos/${repo}`]
				: [`repos/${repo}/actions`, `repos/${repo}/releases`, `repos/${repo}`];
	const observations: (Observation | Source)[] = [];
	for (const path of paths) {
		try {
			observations.push(await client.observation(path, signal));
		} catch (error) {
			if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) throw error;
			observations.push({
				resource: path,
				version: null,
				fetchedAt: null,
				complete: false,
				stale: true,
			});
		}
	}
	return buildInput(repository, domain, observations, now);
}

export function globalInput(
	domain: Domain,
	reports: AnalysisReport[],
	expected: string[],
	now: string,
): AnalysisInput {
	const selected = expected.map(
		(repository) =>
			reports
				.filter(
					(report) =>
						report.scope === "repo" && report.domain === domain && report.repository === repository,
				)
				.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0],
	);
	const sources: Source[] = [];
	const evidence: Evidence[] = [];
	const counts: Record<string, number> = {
		repositories: expected.length,
		missing: 0,
		pass: 0,
		attention: 0,
		fail: 0,
		unknown: 0,
	};
	for (let index = 0; index < expected.length; index++) {
		const report = selected[index];
		const repository = expected[index] as string;
		if (!report) {
			counts.missing = (counts.missing ?? 0) + 1;
			sources.push({
				resource: repository,
				version: null,
				fetchedAt: null,
				complete: false,
				stale: true,
			});
			continue;
		}
		const stale = report.sources.some(
			(source) =>
				source.stale ||
				!source.fetchedAt ||
				Date.parse(now) - Date.parse(source.fetchedAt) > STALE_MS,
		);
		const complete = report.sources.every((source) => source.complete);
		const verdict = stale || !complete ? "unknown" : report.verdict;
		counts[verdict] = (counts[verdict] ?? 0) + 1;
		const sourceTimes = report.sources
			.map((source) => source.fetchedAt)
			.filter((time): time is string => time !== null && Number.isFinite(Date.parse(time)))
			.sort();
		sources.push({
			resource: repository,
			version: report.sourceVersion,
			fetchedAt: sourceTimes[0] ?? null,
			complete,
			stale,
		});
		evidence.push({
			id: `report:${repository}:${domain}`,
			repository,
			kind: "repository-analysis",
			title: report.summary.slice(0, 300),
			state: verdict,
			detail: report.limitations.join("; ").slice(0, 900),
			url: `https://github.com/${repository}`,
			at: report.generatedAt,
		});
	}
	const rank: Record<string, number> = {
		fail: 0,
		attention: 1,
		unknown: 2,
		pass: 3,
	};
	evidence.sort((a, b) => (rank[a.state] ?? 2) - (rank[b.state] ?? 2));
	const omitted = Math.max(0, evidence.length - MAX_EVIDENCE);
	return {
		scope: "global",
		repository: null,
		domain,
		sourceVersion: digest({
			domain,
			sources,
			reports: selected.map((report) =>
				report
					? {
							sourceVersion: report.sourceVersion,
							generatedAt: report.generatedAt,
							verdict: report.verdict,
						}
					: null,
			),
		}),
		observedAt: now,
		sources,
		evidence: evidence.slice(0, MAX_EVIDENCE),
		counts,
		omitted,
		limitations: [
			"Global conclusions summarize repository reports, not a new synchronous GitHub scan.",
			...(counts.missing ? [`${counts.missing} repositories lack this specialist report.`] : []),
			...(omitted
				? [`${omitted} repository summaries omitted; aggregate counts retain all repositories.`]
				: []),
		],
	};
}

export function validReports(
	items: Pick<Resource, "payload" | "status" | "source_version" | "repository">[],
): AnalysisReport[] {
	return items.flatMap((item) => {
		const parsed = analysisReportSchema.safeParse(item.payload);
		return parsed.success &&
			item.status === "completed" &&
			item.repository === parsed.data.repository &&
			item.source_version === parsed.data.sourceVersion
			? [parsed.data]
			: [];
	});
}
