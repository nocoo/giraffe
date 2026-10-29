import { z } from "zod";
import type { ActivitySnapshot } from "../../lib/activity-types";
import type { FactorySnapshot, FactoryStreamData } from "../../lib/factory-types";
import { unknownActivity } from "./activity";
import { type ActivityInputs, projectActivityRepo } from "./activity-projection";
import { readActivityTotals } from "./activity-totals";
import type { Db } from "./db/d1";
import { normalizePublication, resolveFactoryRunReference } from "./db/factory-runs";
import { ApiError } from "./errors";
import { assembleSnapshotGroups, latestSnapshotGroups, type SnapshotPage } from "./snapshot-pages";

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

export const activityPublicationSql =
	"SELECT kind,payload,content_meta FROM refresh_snapshots WHERE account_id=? AND kind IN ('factory','factory#2')";

export function activityPublication(rows: SnapshotPage[]): FactorySnapshot | null {
	const snapshot = assembleSnapshotGroups(rows).get("factory");
	return snapshot ? normalizePublication(snapshot as unknown as FactorySnapshot) : null;
}

export function activityCoverageSummary(publication: FactorySnapshot, truncated: boolean) {
	return {
		repos: {
			status: publication.inventory.complete ? ("complete" as const) : ("partial" as const),
			truncated: publication.truncated === true,
			reason: publication.inventory.complete ? null : "catalog_incomplete",
		},
		run: {
			status: "partial" as const,
			truncated,
			reason: "owner_commit_attribution_unavailable",
		},
		contributions: unknownActivity("native_calendar_has_no_activity_attribution"),
	};
}

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
	const reference = await resolveFactoryRunReference(db, account, parsed.data.run ?? "latest");
	const [catalog, resources, pages, rawItems, publications] = await db.batch<{
		repo_id: string;
		repo: string;
		stream: string;
		item_id: string;
		payload: string;
		kind: string;
		content_meta?: string | null;
	}>([
		db
			.prepare(
				"SELECT c.repo_id,c.repo FROM refresh_catalog c JOIN accounts a ON a.id=c.account_id WHERE c.account_id=? AND c.active=1 AND substr(c.repo,1,instr(c.repo,'/')-1)=a.login COLLATE NOCASE ORDER BY c.repo COLLATE NOCASE",
			)
			.bind(account),
		db
			.prepare(
				"SELECT r.repo_id,r.stream,r.payload FROM refresh_resources r JOIN refresh_catalog c ON c.account_id=r.account_id AND c.repo_id=r.repo_id WHERE r.account_id=? AND c.active=1 AND r.stream IN ('issues','prs','actions','releases')",
			)
			.bind(account),
		db
			.prepare(
				"SELECT s.kind,s.payload FROM refresh_snapshots s JOIN refresh_catalog c ON c.account_id=s.account_id AND c.repo_id=json_extract(s.payload,'$.repo_id') WHERE s.account_id=? AND c.active=1 AND (s.kind LIKE '%:actions' OR s.kind LIKE '%:actions#2') AND substr(s.kind,6,length(c.repo))=c.repo COLLATE NOCASE",
			)
			.bind(account),
		db
			.prepare(
				"SELECT i.repo_id,i.stream,i.item_id,i.payload FROM refresh_items i JOIN refresh_catalog c ON c.account_id=i.account_id AND c.repo_id=i.repo_id WHERE i.account_id=? AND c.active=1",
			)
			.bind(account),
		db.prepare(activityPublicationSql).bind(account),
	]);
	if (!catalog || !resources || !pages || !rawItems || !publications)
		throw new ApiError(500, "db_error", "Incomplete activity inputs");
	if (
		parsed.data.repository &&
		!catalog.results.some((row) => row.repo.toLowerCase() === parsed.data.repository?.toLowerCase())
	)
		throw new ApiError(404, "not_found", "Repository outside current refresh catalog");
	const publication = activityPublication(publications.results);
	if (!publication || (reference !== "latest" && reference !== publication.runId))
		throw new ApiError(
			409,
			"activity_unpublished",
			"No activity observations for this refresh publication",
		);
	const window = { ...publication.window, gap: true, first: true };
	const snapshots = latestSnapshotGroups(pages.results as SnapshotPage[]);
	const members = catalog.results.filter(
		(row) =>
			!parsed.data.repository || row.repo.toLowerCase() === parsed.data.repository.toLowerCase(),
	);
	const repos = members.map((member) => {
		const inputs: ActivityInputs = new Map(
			resources.results
				.filter((row) => row.repo_id === member.repo_id)
				.map((row) => [
					row.stream,
					{
						data: JSON.parse(row.payload) as FactoryStreamData,
						raw: new Map(
							rawItems.results
								.filter((item) => item.repo_id === member.repo_id && item.stream === row.stream)
								.map((item) => [item.item_id, JSON.parse(item.payload) as Record<string, unknown>]),
						),
						snapshot: snapshots.get(`repo:${member.repo}:actions`.toLowerCase())?.data,
					},
				]),
		);
		return projectActivityRepo(
			member.repo,
			publication.repos.find((repo) => repo.id === member.repo_id),
			inputs,
			window,
		);
	});
	const membership = members.map((member) => member.repo);
	const truncated =
		publication.truncated === true ||
		repos.some((repo) => Object.values(repo.coverage).some((coverage) => coverage.truncated));
	return {
		account_id: account,
		runId: publication.runId,
		previousRunId: null,
		fetchedAt: publication.publication?.publishedAt ?? publication.fetched_at,
		window,
		membership,
		repos,
		contributions: null,
		coverage: activityCoverageSummary(publication, truncated),
		truncated,
		...readActivityTotals(repos, membership, publication.inventory.complete !== true),
	};
}
