import { z } from "zod";
import type { ActivityRepo, ActivitySnapshot } from "../../lib/activity-types";
import { unknownActivity } from "./activity";
import { readActivityTotals } from "./activity-totals";
import type { Db } from "./db/d1";
import { resolveFactoryRunReference } from "./db/factory-runs";
import { ApiError } from "./errors";
import { assemblePages } from "./snapshot-pages";

const querySchema = z
	.object({
		run: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,80}$/)
			.optional(),
		repository: z
			.string()
			.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
			.max(200)
			.optional(),
	})
	.strict();
export async function readActivity(
	db: Db,
	account: string,
	query: Record<string, string[]>,
): Promise<ActivitySnapshot & ReturnType<typeof readActivityTotals>> {
	if (Object.values(query).some((values) => values.length !== 1))
		throw new ApiError(400, "validation_failed", "Duplicate activity filter");
	const parsed = querySchema.safeParse(
		Object.fromEntries(Object.entries(query).map(([key, values]) => [key, values[0]])),
	);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "Invalid activity filters");
	const id =
		parsed.data.run === undefined
			? "latest"
			: await resolveFactoryRunReference(db, account, parsed.data.run);
	const target =
		"SELECT a.run_id,a.payload FROM activity_publications a JOIN factory_runs r ON r.id=a.run_id AND r.account_id=a.account_id WHERE a.account_id=? AND (?='latest' OR a.run_id=?) AND r.status IN ('completed','partial') ORDER BY a.until_at DESC,a.run_id LIMIT 1";
	const [headers, pages, runs] = await db.batch<{ payload: string; status: string }>([
		db.prepare(target).bind(account, id, id),
		db
			.prepare(
				`WITH target AS (${target}) SELECT p.payload FROM activity_pages p JOIN target t ON t.run_id=p.run_id WHERE p.account_id=? ORDER BY p.page`,
			)
			.bind(account, id, id, account),
		db.prepare("SELECT status FROM factory_runs WHERE account_id=? AND id=?").bind(account, id),
	]);
	const header = headers?.results[0];
	if (!header) {
		if (id !== "latest" && !runs?.results.length)
			throw new ApiError(404, "not_found", "Unknown activity run");
		throw new ApiError(
			409,
			"activity_unpublished",
			"No successful published account activity for this run",
		);
	}
	const snapshot = JSON.parse(header.payload) as ActivitySnapshot;
	snapshot.repos =
		pages?.results.flatMap((page) => JSON.parse(page.payload) as ActivityRepo[]) ?? [];
	let membership = snapshot.membership ?? snapshot.repos.map((repo) => repo.repo);
	let unknownOmitted = !snapshot.membership && snapshot.truncated;
	const repository = parsed.data.repository;
	if (repository) {
		const frozenMember =
			snapshot.membership?.some((name) => name.toLowerCase() === repository.toLowerCase()) ?? false;
		const matching = snapshot.repos.filter(
			(repo) => repo.repo.toLowerCase() === repository.toLowerCase(),
		);
		if (!matching.length && !frozenMember) {
			const rows = await db
				.prepare(
					"SELECT kind,payload FROM snapshots WHERE account_id=? AND kind IN ('repos','repos#2')",
				)
				.bind(account)
				.all<{ kind: string; payload: string }>();
			const catalog = assemblePages("repos", rows.results);
			if (
				!Array.isArray(catalog.repos) ||
				!catalog.repos.some(
					(repo: { name_with_owner?: string }) =>
						repo.name_with_owner?.toLowerCase() === repository.toLowerCase(),
				)
			)
				throw new ApiError(
					404,
					"not_found",
					"Repository outside frozen activity and current catalog",
				);
		}
		snapshot.repos = matching;
		const omitted =
			!matching.length && (frozenMember || (!snapshot.membership && snapshot.truncated));
		membership = omitted ? [repository] : matching.map((repo) => repo.repo);
		unknownOmitted = false;
		snapshot.contributions = null;
		snapshot.coverage = {
			repos: omitted
				? {
						status: "partial",
						truncated: true,
						reason: "Frozen repository activity was omitted by storage capacity",
					}
				: matching.length
					? (snapshot.coverage.repos ?? unknownActivity("Repository coverage unavailable"))
					: {
							status: "complete",
							truncated: false,
							reason: "Repository not included in this frozen run",
						},
			contributions: unknownActivity("Account contributions cannot be projected to a repository"),
		};
		snapshot.truncated =
			omitted ||
			matching.some((repo) => Object.values(repo.coverage).some((value) => value.truncated));
	}
	return { ...snapshot, ...readActivityTotals(snapshot.repos, membership, unknownOmitted) };
}
