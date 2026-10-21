import { z } from "zod";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { publishedFactory } from "./db/factory-runs";
import { ApiError } from "./errors";
import { observationEnvelope, readObservation, requireCatalogRepo } from "./machine-observations";
import { repoPolicy } from "./repo-statistics";
import { assemblePages, type SnapshotPage } from "./snapshot-pages";

const sourceQuerySchema = z
	.object({
		repository: z
			.string()
			.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
			.max(200)
			.optional(),
		since: z.string().datetime({ offset: true }).optional(),
	})
	.strict();

export async function readSources(db: Db, account: string, query: Record<string, string>) {
	const parsed = sourceQuerySchema.safeParse(query);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid source filters");
	const repository = parsed.data.repository
		? await requireCatalogRepo(db, account, parsed.data.repository)
		: undefined;
	const policy = await repoPolicy(db, account);
	const rows = await db
		.prepare(
			"SELECT kind,payload FROM snapshots WHERE account_id=? AND kind LIKE 'repo:%' AND (kind LIKE '%:issues' OR kind LIKE '%:issues#2' OR kind LIKE '%:prs' OR kind LIKE '%:prs#2' OR kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details' OR kind LIKE '%:details#2')",
		)
		.bind(account)
		.all<SnapshotPage>();
	const groups = new Map<string, SnapshotPage[]>();
	for (const row of rows.results) {
		const key = row.kind.replace(/#2$/, "");
		const name = key.slice(5, key.lastIndexOf(":"));
		if (!policy.includes(name)) continue;
		if (repository && name.toLowerCase() !== repository.toLowerCase()) continue;
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const sources = await Promise.all(
		[...groups].map(async ([resource, pages]) => {
			const envelope = await observationEnvelope(account, resource, assemblePages(resource, pages));
			return {
				resource,
				version: envelope.sourceVersion,
				fetchedAt: envelope.fetchedAt,
				freshness: envelope.freshness,
				coverage: envelope.coverage,
				truncated: envelope.truncated,
				unavailable: envelope.unavailable,
			};
		}),
	);
	for (const resource of ["issues", "prs", "ci", "factory", "repos"]) {
		try {
			const envelope = await readObservation(db, account, resource, "all", policy);
			sources.push({
				resource: `account:${resource}`,
				version: envelope.sourceVersion,
				fetchedAt: envelope.fetchedAt,
				freshness: envelope.freshness,
				coverage: envelope.coverage,
				truncated: envelope.truncated,
				unavailable: envelope.unavailable,
			});
		} catch (error) {
			if (!(error instanceof ApiError) || error.code !== "snapshot_missing") throw error;
		}
	}
	const repositories = policy.repos.map((repo) => repo.name_with_owner).sort();
	const publication = await publishedFactory(db, account);
	for (const repo of publication?.repos ?? []) {
		if (!policy.includes(repo.name)) continue;
		if (repository && repo.name.toLowerCase() !== repository.toLowerCase()) continue;
		for (const stream of FACTORY_STREAMS) {
			const coverage = repo.coverage[stream];
			sources.push({
				resource: `factory:${repo.name}:${stream}`,
				version: repo.observation?.version ?? publication?.runId ?? "",
				fetchedAt: coverage.fetchedAt,
				freshness: {
					oldestAt: coverage.fetchedAt,
					latestAt: coverage.fetchedAt,
					total: 1,
					missing: coverage.status === "complete" ? 0 : 1,
				},
				coverage,
				truncated: coverage.status === "limited",
				unavailable:
					coverage.status === "pending" ||
					coverage.status === "partial" ||
					coverage.status === "unavailable",
			});
		}
	}

	const since = parsed.data.since ? Date.parse(parsed.data.since) : null;
	return {
		account_id: account,
		repositories,
		sources: sources.filter((source) => {
			if (since === null) return true;
			const freshness = source.freshness;
			const latestAt =
				typeof freshness === "object" && freshness !== null && "latestAt" in freshness
					? freshness.latestAt
					: null;
			const times = [source.fetchedAt, latestAt]
				.map((at) => (typeof at === "string" ? Date.parse(at) : NaN))
				.filter(Number.isFinite);
			return times.length === 0 || Math.max(...times) > since;
		}),
	};
}
