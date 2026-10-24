import type {
	ActivityCommit,
	ActivityCoverage,
	ActivityWindow,
	DeferredActivityCommits,
} from "../../lib/activity-types";
import type { FactoryRun } from "../../lib/factory-run";
import type { FactoryRepo } from "../../lib/factory-types";
import { completeActivity, requireActivityWindow, unknownActivity } from "./activity";
import { landedQuota } from "./activity-landed-quota";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { ApiError } from "./errors";
import { factoryNext } from "./factory-collect";
import { object, truncateText } from "./factory-map";
import type { GithubClient } from "./github-client";

type Pending = {
	head: string;
	branch: string | null;
	runId: string;
	window: ActivityWindow;
	at: string;
	bootstrap: boolean;
	mode: "history" | "compare";
	page: number;
	accepted: number;
};
type Head = { head: string | null; pending: string | null };
export type LandedActivity = {
	items: ActivityCommit[];
	deferred: DeferredActivityCommits[];
	coverage: ActivityCoverage;
};
function metadata(run: FactoryRun, repo: FactoryRepo) {
	if (run.repoIds[repo.name] !== repo.id) return undefined;
	return run.steps.find(
		(step) => step.kind === "metadata" && step.repo === repo.name && step.status === "success",
	);
}
const readHead = (db: Db, account: string, repo: string) =>
	db
		.prepare("SELECT head,pending FROM activity_commit_heads WHERE account_id=? AND repo_id=?")
		.bind(account, repo)
		.first<Head>();

export async function collectLandedPage(
	db: Db,
	lease: RunLease,
	repo: FactoryRepo,
	gh: GithubClient,
	token: string,
	clock: () => string,
	heartbeat: () => Promise<void>,
): Promise<{ done: boolean; writes: D1PreparedStatement[] }> {
	const source = metadata(lease.run, repo);
	if (source?.sourceHead === undefined) return { done: true, writes: [] };
	const saved = await readHead(db, lease.run.account_id, repo.id);
	let pending: Pending | null = saved?.pending ? JSON.parse(saved.pending) : null;
	if (!pending && (!source.sourceHead || source.sourceHead === saved?.head))
		return { done: true, writes: [] };
	const initial = !pending;
	pending ??= {
		head: source.sourceHead as string,
		branch: source.sourceBranch ?? null,
		runId: lease.run.id,
		window: requireActivityWindow(lease.run),
		at: clock(),
		bootstrap: !saved?.head,
		mode: saved?.head ? "compare" : "history",
		page: 1,
		accepted: 0,
	};
	let commits: ActivityCommit[] = [];
	let complete = false;
	if (!initial) {
		const path = `/repos/${repo.name}`;
		const url =
			pending.mode === "compare"
				? `${path}/compare/${encodeURIComponent(saved?.head ?? "")}...${encodeURIComponent(pending.head)}?per_page=100&page=${pending.page}`
				: `${path}/commits?sha=${encodeURIComponent(pending.head)}&per_page=100&page=${pending.page}`;
		let response: Response;
		try {
			response = await gh.githubApi(token, url);
		} catch (error) {
			if (
				!(error instanceof ApiError) ||
				![404, 502].includes(error.status) ||
				pending.mode !== "compare"
			)
				throw error;
			await heartbeat();
			pending.mode = "history";
			pending.page = 1;
			pending.accepted = 0;
			return stage(pending, [], false);
		}
		await heartbeat();
		const body: unknown = await response.json();
		if (token && JSON.stringify(body).includes(token))
			throw new ApiError(422, "snapshot_incomplete", "Commit source contains credentials");
		const comparison = object(body);
		if (pending.mode === "compare" && ["diverged", "behind"].includes(String(comparison.status))) {
			pending.mode = "history";
			pending.page = 1;
			pending.accepted = 0;
			return stage(pending, [], false);
		}
		const rows = pending.mode === "compare" ? comparison.commits : body;
		if (!Array.isArray(rows) || rows.length > 100) throw incomplete();
		if (
			pending.mode === "compare" &&
			(!["ahead", "identical"].includes(String(comparison.status)) ||
				!Number.isSafeInteger(comparison.total_commits) ||
				Number(comparison.total_commits) < pending.accepted + rows.length)
		)
			throw incomplete();
		commits = rows.map((row) => mapCommit(row, pending));
		if (
			pending.mode === "history" &&
			pending.page === 1 &&
			!commits.some((commit) => commit.sha === pending.head)
		)
			throw incomplete();
		if (new Set(commits.map((commit) => commit.sha)).size !== commits.length) throw incomplete();
		if (
			await db
				.prepare(
					"SELECT 1 FROM activity_commit_ledger WHERE account_id=? AND repo_id=? AND reconciliation=? AND sha IN (SELECT value FROM json_each(?)) LIMIT 1",
				)
				.bind(
					lease.run.account_id,
					repo.id,
					`${pending.runId}@${pending.head}@${pending.mode}`,
					JSON.stringify(commits.map((commit) => commit.sha)),
				)
				.first()
		)
			throw incomplete();
		const next = factoryNext(response.headers.get("link"), url);
		pending.accepted += commits.length;
		complete =
			pending.mode === "compare" ? pending.accepted === comparison.total_commits : next === null;
		if ((complete && next !== null) || (!complete && rows.length === 0)) throw incomplete();
		pending.page++;
	}
	return stage(pending, commits, complete);

	async function stage(checkpoint: Pending, items: ActivityCommit[], done: boolean) {
		const now = clock();
		const account = lease.run.account_id;
		const payload = done ? null : JSON.stringify(checkpoint);
		const head = done ? checkpoint.head : (saved?.head ?? null);
		const reconciliation = `${checkpoint.runId}@${checkpoint.head}@${checkpoint.mode}`;
		const quota = await landedQuota(db, lease, repo.id, items, head, payload, now, reconciliation);
		return {
			done: done && checkpoint.head === source?.sourceHead,
			writes: [
				quota,
				fenced(
					db,
					lease,
					now,
					"INSERT INTO activity_commit_ledger(account_id,repo_id,sha,first_run_id,observed_at,window_since,window_until,payload,reconciliation) SELECT ?,?,json_extract(value,'$.sha'),json_extract(value,'$.observation.runId'),json_extract(value,'$.observation.at'),json_extract(value,'$.observation.window.since'),json_extract(value,'$.observation.window.until'),value,? FROM json_each(?) WHERE $guard ON CONFLICT(account_id,repo_id,sha) DO UPDATE SET reconciliation=excluded.reconciliation",
					[account, repo.id, reconciliation, JSON.stringify(items)],
				),
				fenced(
					db,
					lease,
					now,
					"INSERT INTO activity_commit_heads(account_id,repo_id,head,pending) SELECT ?,?,?,? WHERE $guard ON CONFLICT(account_id,repo_id) DO UPDATE SET head=excluded.head,pending=excluded.pending",
					[account, repo.id, head, payload],
				),
			],
		};
	}
}
const incomplete = () =>
	new ApiError(422, "snapshot_incomplete", "Pinned commit history incomplete");
function mapCommit(value: unknown, pending: Pending): ActivityCommit {
	const row = object(value);
	const commit = object(row.commit);
	if (
		typeof row.sha !== "string" ||
		!row.sha ||
		row.sha.length > 100 ||
		typeof commit.message !== "string"
	)
		throw incomplete();
	const date = object(commit.committer).date;
	const author = object(row.author).login;
	return {
		sha: row.sha,
		author: typeof author === "string" ? truncateText(author, 100) : null,
		message: truncateText(commit.message.split("\n")[0] ?? "", 240),
		at: typeof date === "string" && Number.isFinite(Date.parse(date)) ? date : null,
		url: typeof row.html_url === "string" ? truncateText(row.html_url, 2048) : "",
		branch: pending.branch,
		is_default_branch: true,
		observation: {
			runId: pending.runId,
			window: pending.window,
			at: pending.at,
			bootstrap: pending.bootstrap,
		},
	};
}

export async function readLandedActivity(
	db: Db,
	run: FactoryRun,
	repo: FactoryRepo,
): Promise<LandedActivity> {
	const source = metadata(run, repo);
	if (source?.sourceHead === undefined)
		return {
			items: [],
			deferred: [],
			coverage: unknownActivity("Default-branch observation metadata unavailable"),
		};
	const head = await readHead(db, run.account_id, repo.id);
	const rows = await db
		.prepare(
			"SELECT payload FROM activity_commit_ledger WHERE account_id=? AND repo_id=? AND published_run_id IS NULL ORDER BY window_until,first_run_id,sha LIMIT 501",
		)
		.bind(run.account_id, repo.id)
		.all<{ payload: string }>();
	const items: ActivityCommit[] = [];
	const deferred: DeferredActivityCommits[] = [];
	const window = requireActivityWindow(run);
	for (const row of rows.results.slice(0, 500)) {
		const commit = JSON.parse(row.payload) as ActivityCommit;
		const observation = commit.observation;
		if (!observation) throw incomplete();
		if (observation.window.since === window.since && observation.window.until === window.until)
			items.push(commit);
		else {
			let group = deferred.find((group) => group.runId === observation.runId);
			if (!group) {
				group = { runId: observation.runId, window: observation.window, items: [] };
				deferred.push(group);
			}
			group.items.push(commit);
		}
	}
	const complete =
		source?.sourceHead !== undefined &&
		!head?.pending &&
		(!source.sourceHead || head?.head === source.sourceHead);
	return {
		items,
		deferred,
		coverage: !complete
			? unknownActivity("Pinned default-branch observation incomplete")
			: rows.results.length > 500
				? {
						status: "partial",
						truncated: true,
						reason:
							"Pending default commits exceed the 500-item publication budget; retained for their original windows",
					}
				: completeActivity(),
	};
}
