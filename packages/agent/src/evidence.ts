import { createHash } from "node:crypto";
import type { Domain, Evidence, Observation, Source } from "./contracts.ts";
import { repositorySchema } from "./contracts.ts";

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
