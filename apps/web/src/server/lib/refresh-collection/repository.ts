import type { FactoryEvent, FactoryRepo, FactoryStreamData } from "../../../lib/factory-types";
import { ApiError } from "../errors";
import {
	mapActionRuns,
	mapIssues,
	mapPullRequests,
	mapReleases,
	mapRepoDetails,
} from "../github-map";
import type { CollectionContext, CollectionResult } from "../refresh-collection-contract";
import { collectItems, collectRest, type Dimension, failure, terminal } from "./dimensions";
import {
	blankDay,
	blankMetrics,
	type Catalog,
	count,
	type DayObservation,
	event,
	factoryRepo,
	type Node,
	object,
	unavailable,
	windowOf,
} from "./model";
import { repositoryQuery } from "./queries";
import { collectionDb, dayStatements, publish, resourceStatement, snapshots } from "./store";
import { transport } from "./transport";

const inDay = (value: string | null | undefined, since: string, until: string) =>
	value !== null &&
	value !== undefined &&
	Date.parse(value) >= Date.parse(since) &&
	Date.parse(value) < Date.parse(until);
function dayItems(items: FactoryEvent[], since: string, until: string) {
	return items.filter((item) =>
		[item.at, item.createdAt, item.closedAt, item.mergedAt].some((at) => inDay(at, since, until)),
	);
}
function mappedRows(stream: string, raw: Node[], repo: string) {
	if (stream === "issues")
		return mapIssues(
			raw
				.filter((row) => row.state === "OPEN")
				.map((row) => ({ ...row, repository: { nameWithOwner: repo } })),
		);
	if (stream === "prs")
		return mapPullRequests(raw.map((row) => ({ ...row, repository: { nameWithOwner: repo } })));
	if (stream === "actions") return mapActionRuns({ workflow_runs: raw });
	if (stream === "releases") return mapReleases(raw);
	return raw.map((row) => ({
		name_with_owner: repo,
		source: row.source,
		severity:
			object(row.security_advisory).severity ?? object(row.rule).security_severity_level ?? null,
		summary: object(row.security_advisory).summary ?? object(row.rule).description ?? "",
		url: row.html_url,
	}));
}

export async function collectRepository(
	context: CollectionContext,
	name: string,
): Promise<CollectionResult> {
	const db = collectionDb(context);
	const saved = await db
		.prepare(
			"SELECT * FROM refresh_catalog WHERE account_id=? AND repo=? COLLATE NOCASE AND active=1",
		)
		.bind(context.account.id, name)
		.first<Catalog>();
	if (!saved) throw new ApiError(404, "not_found", "Repository not found in current catalogue");
	const previous = (
		await db
			.prepare(
				"SELECT * FROM refresh_day_observations WHERE account_id=? AND repo_id=? AND timezone=?",
			)
			.bind(context.account.id, saved.repo_id, context.run.params.timezone)
			.all<DayObservation>()
	).results;
	const needed = context.run.params.dimensions.filter(
		(dimension) =>
			context.run.params.force ||
			context.days.some(
				(day) =>
					!previous.some(
						(row) =>
							row.day === day.date && row.dimension === dimension && row.status === "complete",
					),
			),
	);
	const upstream = transport(context);
	const commitDays = needed.includes("commits")
		? context.days.filter(
				(day) =>
					context.run.params.force ||
					!previous.some(
						(row) =>
							row.day === day.date && row.dimension === "commits" && row.status === "complete",
					),
			)
		: [];
	const variables: Node = { id: saved.repo_id };
	for (const [index, day] of commitDays.entries()) {
		variables[`since${index}`] = day.since;
		variables[`until${index}`] = new Date(Date.parse(day.until) - 1).toISOString();
	}
	const prior = !needed.length
		? await db
				.prepare(
					"SELECT payload FROM refresh_repository_publications WHERE account_id=? AND repo_id=?",
				)
				.bind(context.account.id, saved.repo_id)
				.first<{ payload: string }>()
		: null;
	const data = needed.length
		? await upstream.request((client) =>
				client.githubGraphql(
					context.token,
					repositoryQuery(commitDays, needed.includes("issues"), needed.includes("prs")),
					variables,
				),
			)
		: { node: JSON.parse(saved.payload) as Node };
	const raw = object(data.node);
	if (
		raw.id !== saved.repo_id ||
		String(raw.nameWithOwner).toLowerCase() !== saved.repo.toLowerCase()
	)
		throw new ApiError(502, "github_error", "Repository identity unavailable");
	const repo: FactoryRepo = prior
		? {
				...(JSON.parse(prior.payload) as FactoryRepo),
				coverage: factoryRepo(raw, context).coverage,
				metrics: blankMetrics(),
			}
		: factoryRepo(raw, context);
	const observations: DayObservation[] = [];
	const writes: D1PreparedStatement[] = [];
	const results = new Map<string, Dimension>();
	let pendingError: unknown;
	for (const dimension of needed) {
		if (dimension === "commits") {
			const target = object(object(raw.defaultBranchRef).target);
			for (const [index, day] of commitDays.entries()) {
				const total = raw.isEmpty === true ? 0 : count(object(target[`day${index}`]).totalCount);
				observations.push({
					day: day.date,
					dimension,
					status: total === null ? "unavailable" : "complete",
					payload: JSON.stringify({
						count: total,
						items: [],
						source: "github_graphql_history",
						since: day.since,
						until: day.until,
					}),
					fetched_at: context.now,
				});
			}
			continue;
		}
		let result: Dimension;
		try {
			if (pendingError) result = failure(pendingError);
			else if (dimension === "issues" || dimension === "prs") {
				const cached = (
					await db
						.prepare(
							"SELECT item_id,payload FROM refresh_items WHERE account_id=? AND repo_id=? AND stream=?",
						)
						.bind(context.account.id, saved.repo_id, dimension)
						.all<{ item_id: string; payload: string }>()
				).results;
				const merged = new Map(
					cached.map((item) => [item.item_id, JSON.parse(item.payload) as Node]),
				);
				const completeThrough = previous
					.filter(
						(row) =>
							row.dimension === dimension &&
							row.status === "complete" &&
							object(JSON.parse(row.payload)).inventoryComplete === true,
					)
					.map((row) => row.fetched_at)
					.sort()
					.at(-1);
				result = await collectItems(
					context,
					upstream,
					saved.repo_id,
					dimension,
					object(raw[dimension === "prs" ? "pullRequests" : "issues"]),
					merged,
					completeThrough ?? null,
				);
				for (const item of result.raw) merged.set(String(item.id), item);
				writes.push(
					db
						.prepare(
							`INSERT INTO refresh_items(account_id,repo_id,stream,item_id,payload) SELECT ?,?,?,json_extract(value,'$.id'),value FROM json_each(?) WHERE 1 ON CONFLICT(account_id,repo_id,stream,item_id) DO UPDATE SET payload=excluded.payload`,
						)
						.bind(context.account.id, saved.repo_id, dimension, JSON.stringify(result.raw)),
				);
				result = { ...result, raw: [...merged.values()], items: [...merged.values()].map(event) };
			} else result = await collectRest(context, upstream, saved.repo, dimension);
		} catch (error) {
			result = failure(error);
			if (terminal(error)) pendingError = error;
		}
		results.set(dimension, result);
		for (const day of context.days) {
			if (
				!context.run.params.force &&
				previous.some(
					(row) => row.day === day.date && row.dimension === dimension && row.status === "complete",
				)
			)
				continue;
			const items =
				dimension === "alerts"
					? result.items
					: dimension === "releases"
						? result.items.filter((item) => inDay(item.at, day.since, day.until))
						: dayItems(result.items, day.since, day.until);
			observations.push({
				day: day.date,
				dimension,
				status: result.status,
				payload: JSON.stringify({
					count: result.status === "complete" ? items.length : null,
					observed: items.length,
					items,
					source: result.source,
					reason: result.reason,
					inventoryComplete: result.inventoryComplete,
					since: day.since,
					until: day.until,
				}),
				fetched_at: context.now,
			});
		}
	}
	const current = new Map(previous.map((row) => [`${row.day}:${row.dimension}`, row]));
	for (const row of observations) current.set(`${row.day}:${row.dimension}`, row);
	for (const dimension of context.run.params.dimensions) {
		const selected = context.days.map((day) => current.get(`${day.date}:${dimension}`));
		const available = selected.filter(
			(row): row is DayObservation => row !== undefined && row.status === "complete",
		);
		const latest = selected
			.filter((row): row is DayObservation => row !== undefined)
			.sort((first, second) => second.fetched_at.localeCompare(first.fetched_at))[0];
		const inventoryComplete =
			dimension === "issues" || dimension === "prs"
				? (results.get(dimension)?.inventoryComplete ??
					object(JSON.parse(latest?.payload ?? "{}")).inventoryComplete === true)
				: undefined;
		const coverage = {
			...unavailable(dimension),
			...(inventoryComplete === undefined ? {} : { inventoryComplete }),
			source:
				dimension === "commits"
					? "github_graphql_history"
					: (results.get(dimension)?.source ??
						(dimension === "issues" || dimension === "prs"
							? "github_graphql"
							: "github_rest_latest")),
			status:
				available.length === selected.length
					? ("complete" as const)
					: available.length || selected.some((row) => row?.status === "partial")
						? ("partial" as const)
						: ("unavailable" as const),
			pages:
				results.has(dimension) || (dimension === "commits" && needed.includes(dimension)) ? 1 : 0,
			fetchedAt:
				selected
					.filter((row) => row?.status !== "unavailable")
					.map((row) => row?.fetched_at ?? "")
					.filter(Boolean)
					.sort()[0] ?? null,
			observed: available.length,
			reason: available.length === selected.length ? null : "missing_days",
			completeWindows: available.flatMap((row) => {
				const payload = JSON.parse(row.payload) as Node;
				return [
					{
						since: String(payload.since),
						until: new Date(Date.parse(String(payload.until)) - 1).toISOString(),
						timezone: context.run.params.timezone,
					},
				];
			}),
			strategy: needed.includes(dimension) ? ("incremental" as const) : ("reused" as const),
		};
		repo.coverage[dimension] = coverage;
		const items = new Map<string, FactoryEvent>();
		for (const day of context.days) {
			const row = current.get(`${day.date}:${dimension}`);
			if (!row || row.status === "unavailable") continue;
			const value = JSON.parse(row.payload) as { count: number | null; items: FactoryEvent[] };
			for (const item of value.items) items.set(item.id, item);
			if (row.status !== "complete") continue;
			const metrics = repo.metrics.days[row.day] ?? blankDay();
			if (dimension === "commits") {
				metrics.commits = Number(value.count);
				repo.metrics.commits += Number(value.count);
			}
			for (const item of value.items) {
				if (dimension === "issues") {
					if (inDay(item.createdAt, day.since, day.until)) metrics.issueOpened++;
					if (inDay(item.closedAt, day.since, day.until)) metrics.issueClosed++;
				}
				if (dimension === "prs") {
					if (inDay(item.createdAt, day.since, day.until)) metrics.prOpened++;
					if (inDay(item.mergedAt, day.since, day.until)) metrics.prMerged++;
					else if (inDay(item.closedAt, day.since, day.until)) metrics.prClosed++;
				}
				if (dimension === "actions") {
					if (item.conclusion === "success") metrics.ciSuccess++;
					else if (
						["failure", "timed_out", "cancelled", "action_required"].includes(item.conclusion ?? "")
					)
						metrics.ciFailure++;
					else if (item.state === "completed") repo.metrics.ciOther++;
					else repo.metrics.ciPending++;
				}
				if (dimension === "releases") metrics.releases++;
			}
			repo.metrics.days[row.day] = metrics;
		}
		const resource: FactoryStreamData = {
			runId: context.run.id,
			items: [...items.values()],
			next: null,
			ranges: coverage.completeWindows,
			coverage,
		};
		writes.push(await resourceStatement(db, context, saved.repo_id, dimension, resource));
		const result = results.get(dimension);
		if (result) {
			const key =
				dimension === "actions"
					? "runs"
					: dimension === "alerts"
						? "items"
						: dimension === "prs"
							? "pull_requests"
							: dimension;
			const security =
				dimension === "alerts"
					? {
							features: result.features,
							dependabot_open:
								!result.features || result.features.dependabot.status === "unavailable"
									? null
									: result.raw.filter((row) => row.source === "dependabot").length,
							code_scanning_open:
								!result.features || result.features.code_scanning.status === "unavailable"
									? null
									: result.raw.filter((row) => row.source === "code_scanning").length,
						}
					: {};
			writes.push(
				...(await snapshots(
					db,
					context.account.id,
					`repo:${saved.repo}:${dimension === "alerts" ? "security" : dimension}`,
					{
						[key]: mappedRows(dimension, result.raw, saved.repo),
						repo_id: saved.repo_id,
						...security,
						truncated: result.status !== "complete" || inventoryComplete === false,
						inventory_complete: inventoryComplete,
						unavailable: result.status === "unavailable",
						window: windowOf(context),
						coverage,
						source: result.source,
					},
					context.now,
				)),
			);
		}
	}
	for (const metrics of Object.values(repo.metrics.days))
		for (const key of [
			"issueOpened",
			"issueClosed",
			"prOpened",
			"prMerged",
			"prClosed",
			"ciSuccess",
			"ciFailure",
			"releases",
		] as const)
			repo.metrics[key] += metrics[key];
	repo.metrics.alerts =
		results.get("alerts")?.items.length ??
		Math.max(
			0,
			...context.days.map((day) => {
				const value = current.get(`${day.date}:alerts`);
				return value?.status === "complete" ? Number((JSON.parse(value.payload) as Node).count) : 0;
			}),
		);
	const fetchedAt =
		Object.values(repo.coverage)
			.flatMap((coverage) => (coverage.fetchedAt ? [coverage.fetchedAt] : []))
			.sort()
			.at(-1) ??
		repo.metadataAt ??
		saved.fetched_at;
	repo.observation = {
		version: context.run.id,
		window: windowOf(context),
		refreshedAt: fetchedAt,
		metadataAt: repo.metadataAt ?? saved.fetched_at,
		publishedAt: context.now,
		source: "run",
		repo: saved.repo,
	};
	writes.push(
		dayStatements(db, context, saved.repo_id, observations),
		db
			.prepare(
				"INSERT INTO refresh_repository_publications(account_id,repo_id,payload,fetched_at) VALUES(?,?,?,?) ON CONFLICT(account_id,repo_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(context.account.id, saved.repo_id, JSON.stringify(repo), context.now),
	);
	if (needed.length)
		writes.push(
			...(await snapshots(
				db,
				context.account.id,
				`repo:${saved.repo}:details`,
				{
					repo_id: saved.repo_id,
					...mapRepoDetails({
						description: raw.description,
						default_branch: repo.branch,
						archived: raw.isArchived,
						open_issues_count: repo.openIssues,
						stargazers_count: raw.stargazerCount,
						forks_count: raw.forkCount,
						pushed_at: raw.pushedAt,
						html_url: raw.url,
					}),
				},
				context.now,
			)),
		);
	await db.batch(writes);
	await publish(db, context);
	if (pendingError) throw pendingError;
	return {
		requests: upstream.client.count,
		partial: context.run.params.dimensions.some(
			(dimension) =>
				repo.coverage[dimension].status !== "complete" ||
				repo.coverage[dimension].inventoryComplete === false,
		),
	};
}
