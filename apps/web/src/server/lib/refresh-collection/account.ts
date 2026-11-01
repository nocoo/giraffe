import type { FactorySnapshot } from "../../../lib/factory-types";
import { publishedFactory } from "../db/factory-runs";
import { ApiError } from "../errors";
import { TruncatedError } from "../github-client";
import { mapRepos } from "../github-map";
import { annualCalendarCoverage, contributionWindow } from "../refresh-calendar";
import type { AccountCollectionResult, CollectionContext } from "../refresh-collection-contract";
import {
	catalogPayload,
	count,
	type Node,
	newlyCreatedRepo,
	nodes,
	object,
	ownedBy,
	shanghaiDay,
	text,
	windowOf,
} from "./model";
import { accountQuery } from "./queries";
import { catalog, collectionDb, publish, savedAccountPublication, snapshots } from "./store";
import { transport } from "./transport";

const contributionGraphqlPath = (path: string[]) =>
	path.some(
		(segment) => segment === "contributionsCollection" || segment === "contributionCalendar",
	);

export async function collectAccount(context: CollectionContext): Promise<AccountCollectionResult> {
	const db = collectionDb(context);
	const { client, request, breakdown } = transport(context);
	const calendarWindow = contributionWindow(context.now);
	let after: string | null = null;
	let pages = 0;
	let complete = false;
	let restricted = false;
	let first: Node = {};
	const repositories: Node[] = [];
	const cursors = new Set<string>();
	do {
		let data: Node;
		try {
			data = await request((github) =>
				github.githubGraphql(context.token, accountQuery, { after, ...calendarWindow }),
			);
		} catch (error) {
			if (
				!pages ||
				!(
					error instanceof TruncatedError ||
					(error instanceof ApiError && error.code === "github_error")
				)
			)
				throw error;
			break;
		}
		restricted ||=
			client.graphqlErrors.length > 0 &&
			client.graphqlErrors.some((error) => !contributionGraphqlPath(error.path));
		if (!pages) first = data;
		const viewer = object(data.viewer);
		if (viewer.login !== context.account.login)
			throw new ApiError(401, "github_unauthorized", "github account mismatch");
		const connection = object(viewer.repositories);
		if (!Array.isArray(connection.nodes)) break;
		const page = nodes(connection.nodes);
		if (
			page.some((repo) => !text(repo.id) || !/^[^/\s]+\/[^/\s]+$/.test(String(repo.nameWithOwner)))
		)
			break;
		repositories.push(...page);
		pages += 1;
		const info = object(connection.pageInfo);
		if (info.hasNextPage === false) {
			complete =
				!restricted &&
				(count(object(object(first.viewer).repositories).totalCount) ?? repositories.length) <=
					repositories.length;
			break;
		}
		after = text(info.endCursor);
		if (!after || cursors.has(after) || pages >= 35) break;
		cursors.add(after);
	} while (after);
	const date = new Intl.DateTimeFormat("en-CA", {
		timeZone: context.run.params.timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(context.now));
	const contributions = object(
		object(object(first.viewer).contributionsCollection).contributionCalendar,
	);
	const contributionDays = nodes(contributions.weeks).flatMap((week) =>
		nodes(week.contributionDays),
	);
	const days = contributionDays.flatMap((day) =>
		count(day.contributionCount) === null || !text(day.date)
			? []
			: [
					{
						date: String(day.date),
						count: Number(day.contributionCount),
						fetchedAt: context.now,
						observedAt: context.now,
						breakdown: "unavailable" as const,
					},
				],
	);
	const contributionComplete = annualCalendarCoverage({
		fetchedAt: context.now,
		window: calendarWindow,
		days,
		total: count(contributions.totalContributions),
	}).complete;
	const priorAccount = await savedAccountPublication(db, context.account.id);
	const priorFactoryRow = await db
		.prepare("SELECT payload FROM refresh_snapshots WHERE account_id=? AND kind='factory'")
		.bind(context.account.id)
		.first<{ payload: string }>();
	const priorFactoryFromRow = priorFactoryRow
		? (JSON.parse(priorFactoryRow.payload) as FactorySnapshot)
		: null;
	const priorFactoryPublished = await publishedFactory(db, context.account.id).catch(() => null);
	const priorFactory = priorFactoryPublished ?? priorFactoryFromRow;
	const retainedContribution = priorAccount?.contribution?.days?.length
		? priorAccount.contribution
		: priorFactoryFromRow?.contribution?.days?.length
			? priorFactoryFromRow.contribution
			: priorFactory?.contribution;
	const contributionRetained = contributionComplete || Boolean(retainedContribution?.days?.length);
	const contributionGraphqlErrors = client.graphqlErrors.filter((error) =>
		contributionGraphqlPath(error.path),
	);
	const contributionFailures =
		contributionGraphqlErrors.length > 0
			? contributionGraphqlErrors.map((error) => ({
					dimension: null,
					code: "contributions:graphql_error" as const,
					httpStatus: null,
					graphqlType:
						(typeof (error as { message?: string }).message === "string" &&
							(error as { message?: string }).message) ||
						(typeof error.type === "string" ? error.type : null),
					graphqlPath: Array.isArray(error.path) ? error.path.map(String) : null,
				}))
			: [];
	if (contributionFailures.length) context.onFailures?.(contributionFailures);
	const rate = object(first.rateLimit);
	const snapshot: FactorySnapshot = {
		schema: 1,
		account_id: context.account.id,
		owner: context.account.login,
		runId: context.run.id,
		revision: 1,
		leaseUntil: null,
		startedAt: context.run.createdAt,
		fetched_at: context.now,
		window: windowOf(context),
		status: complete && (contributionComplete || contributionRetained) ? "complete" : "partial",
		inventory: {
			total: count(object(object(first.viewer).repositories).totalCount) ?? repositories.length,
			scanned: repositories.length,
			complete,
			after,
			pages,
			excluded: [],
		},
		repos: [],
		cursor: { repo: 0, stream: 0 },
		requests: client.count,
		rate:
			count(rate.remaining) === null
				? null
				: {
						remaining: Number(rate.remaining),
						resetAt: text(rate.resetAt),
						resource: "graphql",
						observedAt: context.now,
					},
		contribution: contributionComplete
			? {
					days,
					total: Number(contributions.totalContributions),
					restricted: count(
						object(object(first.viewer).contributionsCollection).restrictedContributionsCount,
					),
					fetchedAt: context.now,
					observedAt: context.now,
					timezone: "github",
					typesStatus: "partial",
				}
			: (retainedContribution ?? null),
		contributionStatus: contributionComplete
			? "complete"
			: retainedContribution?.days?.length
				? (priorAccount?.contributionStatus ?? priorFactory?.contributionStatus ?? "complete")
				: "unavailable",
		contributionObservation: contributionComplete
			? {
					version: context.run.id,
					window: calendarWindow,
					fetchedAt: context.now,
				}
			: (priorAccount?.contributionObservation ??
				priorFactory?.contributionObservation ?? {
					version: context.run.id,
					window: calendarWindow,
					fetchedAt: context.now,
				}),
	};
	const statements = [
		db
			.prepare(
				"INSERT INTO refresh_accounts(account_id,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(context.account.id, JSON.stringify(snapshot), context.now),
	];
	if (complete)
		statements.push(
			db.prepare("UPDATE refresh_catalog SET active=0 WHERE account_id=?").bind(context.account.id),
		);
	statements.push(
		db
			.prepare(`UPDATE refresh_catalog SET active=0 WHERE account_id=? AND active=1 AND EXISTS(
 SELECT 1 FROM json_each(?) observed WHERE refresh_catalog.repo=json_extract(observed.value,'$.nameWithOwner') COLLATE NOCASE AND refresh_catalog.repo_id<>json_extract(observed.value,'$.id'))`)
			.bind(context.account.id, JSON.stringify(repositories)),
		db
			.prepare(`INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active)
 SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.nameWithOwner'),?,?,value,?,1 FROM json_each(?) WHERE 1
 ON CONFLICT(account_id,repo_id) DO UPDATE SET repo=excluded.repo,payload=excluded.payload,fetched_at=excluded.fetched_at,active=1`)
			.bind(
				context.account.id,
				date,
				context.run.params.timezone,
				context.now,
				JSON.stringify(repositories),
			),
	);
	statements.push(
		db
			.prepare(
				"DELETE FROM refresh_snapshots WHERE account_id=? AND kind LIKE 'repo:%' AND NOT EXISTS(SELECT 1 FROM refresh_catalog c WHERE c.account_id=refresh_snapshots.account_id AND c.active=1 AND c.repo_id=json_extract(refresh_snapshots.payload,'$.repo_id') AND c.repo=substr(refresh_snapshots.kind,6,instr(substr(refresh_snapshots.kind,6),':')-1) COLLATE NOCASE)",
			)
			.bind(context.account.id),
	);
	const avatar = text(object(first.viewer).avatarUrl);
	if (avatar !== null)
		statements.push(
			db.prepare("UPDATE accounts SET avatar_url=? WHERE id=?").bind(avatar, context.account.id),
		);
	const mapped = repositories.map((row) => ({
		...object(mapRepos([row])[0]),
		id: row.id,
	}));
	statements.push(
		...(await snapshots(
			db,
			context.account.id,
			"repos",
			{ repos: mapped, truncated: !complete, catalog_complete: complete },
			context.now,
		)),
	);
	await publish(db, context, statements, {
		updateFactorySnapshot: context.publishFactorySnapshot !== false,
	});
	const saved = (await catalog(db, context.account.id)).results;
	const requestedRepo = context.run.params.repo;
	const reasons = [
		...(complete ? [] : ["catalog:incomplete"]),
		...(contributionComplete || contributionRetained ? [] : ["contributions:unavailable"]),
	];
	if (requestedRepo) {
		const requested = saved.find((repo) => repo.repo.toLowerCase() === requestedRepo.toLowerCase());
		if (!requested)
			throw new ApiError(404, "not_found", "Repository not found in current catalogue");
		return {
			requests: client.count,
			requestBreakdown: breakdown(),
			partial: reasons.length > 0,
			reasons,
			repos: [requested.repo],
			failures: contributionFailures,
		};
	}
	const day = shanghaiDay(context.now);
	const lookbackDays = context.run.params.lookbackDays;
	const candidates = await db
		.prepare(`SELECT c.repo,c.payload,
 EXISTS(SELECT 1 FROM repo_stars s WHERE s.account_id=c.account_id AND s.repo=c.repo COLLATE NOCASE AND s.starred=1) AS starred,
 EXISTS(SELECT 1 FROM refresh_repository_publications p WHERE p.account_id=c.account_id AND p.repo_id=c.repo_id) AS observed
 FROM refresh_catalog c WHERE c.account_id=? AND c.active=1 ORDER BY c.repo COLLATE NOCASE`)
		.bind(context.account.id)
		.all<{ repo: string; payload: string; starred: number; observed: number }>();
	return {
		requests: client.count,
		requestBreakdown: breakdown(),
		partial: reasons.length > 0,
		reasons,
		repos: candidates.results
			.filter((row) => {
				if (lookbackDays !== undefined) return row.starred === 1;
				if (row.starred === 1) return true;
				const raw = catalogPayload(row.payload);
				if (!raw || !ownedBy(text(object(raw.owner).login), context.account.login)) return false;
				return !row.observed && newlyCreatedRepo(raw, day.since, day.until);
			})
			.map((row) => row.repo),
		failures: contributionFailures,
	};
}
