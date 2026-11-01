import type { FactoryEvent, FactoryRepo, FactoryStreamData } from "../../../lib/factory-types";
import {
	REFRESH_DIMENSIONS,
	type RefreshDimension,
	type RefreshFailureDetail,
} from "../../../lib/refresh-types";
import { ApiError } from "../errors";
import {
	mapActionRuns,
	mapIssues,
	mapPullRequests,
	mapReleases,
	mapRepoDetails,
} from "../github-map";
import type { CollectionContext, CollectionResult } from "../refresh-collection-contract";
import {
	collectItems,
	collectReleases,
	collectRest,
	type Dimension,
	failure,
	terminal,
} from "./dimensions";
import { dayCoverage, dayNeedsRefresh, PUBLICATION_DAYS, publicationDays } from "./history";
import {
	closedIssueSearchQuery,
	dropStaleOpen,
	lifecycleCalendarRange,
	lifecycleEvents,
	lifecycleFromResponse,
	mergedPrSearchQuery,
	mergeLifecycleRaw,
} from "./lifecycle";
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
function partialBoundaryDay(context: CollectionContext, oldestAt: string): string {
	const hit = context.days.find((day) => inDay(oldestAt, day.since, day.until));
	if (hit) return hit.date;
	if (context.days[0] && Date.parse(oldestAt) < Date.parse(context.days[0].since))
		return context.days[0].date;
	return context.days.at(-1)?.date ?? oldestAt.slice(0, 10);
}
function observationForDay(
	result: Dimension,
	dimension: string,
	day: { date: string; since: string; until: string },
	context: CollectionContext,
	items: FactoryEvent[],
	unavailableTerminal: boolean,
) {
	if (unavailableTerminal) {
		return {
			status: "complete" as const,
			reason: result.reason,
			count: result.status === "complete" ? items.length : null,
		};
	}
	if (
		result.status === "partial" &&
		(dimension === "actions" || dimension === "releases") &&
		result.oldestAt
	) {
		const boundary = partialBoundaryDay(context, result.oldestAt);
		if (day.date > boundary) {
			return { status: "complete" as const, reason: null, count: items.length };
		}
		return { status: "partial" as const, reason: result.reason, count: null };
	}
	return {
		status: (unavailableTerminal ? "complete" : result.status) as DayObservation["status"],
		reason: result.reason,
		count: result.status === "complete" ? items.length : null,
	};
}
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
		return mapPullRequests(
			raw
				.filter((row) => row.state === "OPEN")
				.map((row) => ({ ...row, repository: { nameWithOwner: repo } })),
		);
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

function attributedFailures(
	recorded: RefreshFailureDetail[],
	needed: string[],
	results: Map<string, Dimension>,
): RefreshFailureDetail[] {
	const attributed = [...recorded];
	for (const dimension of needed) {
		if (attributed.some((failure) => failure.dimension === dimension)) continue;
		const reason = results.get(dimension)?.reason;
		if (!reason) continue;
		attributed.push({
			dimension,
			code: reason,
			httpStatus: null,
			graphqlType: null,
			graphqlPath: null,
		});
	}
	return attributed;
}

export async function collectRepository(
	context: CollectionContext,
	name: string,
): Promise<CollectionResult> {
	const db = collectionDb(context);
	const accountId = context.account.id;
	const catalogue =
		"SELECT repo_id FROM refresh_catalog WHERE account_id=? AND repo=? COLLATE NOCASE AND active=1";
	const [savedResult, observationResult, priorResult] = (await db.batch([
		db
			.prepare(
				"SELECT * FROM refresh_catalog WHERE account_id=? AND repo=? COLLATE NOCASE AND active=1",
			)
			.bind(accountId, name),
		db
			.prepare(
				`SELECT * FROM refresh_day_observations WHERE account_id=? AND repo_id=(${catalogue}) AND timezone=? AND (day IN (SELECT day FROM refresh_day_observations WHERE account_id=? AND repo_id=(${catalogue}) AND timezone=? GROUP BY day ORDER BY day DESC LIMIT ${PUBLICATION_DAYS}) OR day BETWEEN ? AND ?)`,
			)
			.bind(
				accountId,
				accountId,
				name,
				context.run.params.timezone,
				accountId,
				accountId,
				name,
				context.run.params.timezone,
				context.run.params.since,
				context.run.params.until,
			),
		db
			.prepare(
				`SELECT payload FROM refresh_repository_publications WHERE account_id=? AND repo_id=(${catalogue})`,
			)
			.bind(accountId, accountId, name),
	])) as [D1Result<Catalog>, D1Result<DayObservation>, D1Result<{ payload: string }>];
	const saved = savedResult.results[0];
	if (!saved) throw new ApiError(404, "not_found", "Repository not found in current catalogue");
	const previous = observationResult.results;
	const needed = context.run.params.dimensions.filter((dimension) =>
		context.days.some((day) => dayNeedsRefresh(context, previous, day, dimension)),
	) as RefreshDimension[];
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
	const restOnly =
		needed.length > 0 &&
		needed.every((dimension) => dimension === "actions" || dimension === "alerts");
	const priorRow = priorResult.results[0];
	const prior = priorRow ? { payload: priorRow.payload } : null;
	const metadataQuery =
		context.run.params.force ||
		needed.some((dimension) => dimension !== "actions" && dimension !== "alerts") ||
		(restOnly && (prior === null || context.run.params.force));
	const lifecycleRange = lifecycleCalendarRange(context.days);
	const wantLifecycle =
		metadataQuery === true &&
		lifecycleRange !== null &&
		needed.some((dimension) => dimension === "issues" || dimension === "prs");
	if (wantLifecycle && lifecycleRange) {
		for (const dimension of needed) {
			if (dimension === "prs")
				variables.mergedQuery = mergedPrSearchQuery(saved.repo, lifecycleRange);
			if (dimension === "issues")
				variables.closedQuery = closedIssueSearchQuery(saved.repo, lifecycleRange);
		}
	}
	const data = metadataQuery
		? await upstream.request((client) =>
				client.githubGraphql(
					context.token,
					repositoryQuery(commitDays, needed, wantLifecycle),
					variables,
				),
			)
		: { node: JSON.parse(saved.payload) as Node };
	const lifecycleRaw = wantLifecycle ? lifecycleFromResponse(object(data), needed) : null;
	const denied = upstream.client.graphqlErrors.length > 0;
	const raw = object(data.node);
	if (
		raw.id !== saved.repo_id ||
		String(raw.nameWithOwner).toLowerCase() !== saved.repo.toLowerCase()
	)
		throw new ApiError(502, "github_error", "Repository identity unavailable");
	const repo: FactoryRepo =
		!metadataQuery && prior
			? {
					...(JSON.parse(prior.payload) as FactoryRepo),
					coverage: factoryRepo(raw, context).coverage,
					metrics: blankMetrics(),
				}
			: factoryRepo(raw, context);
	const observations: DayObservation[] = [];
	const writes: D1PreparedStatement[] = [];
	const results = new Map<string, Dimension>();
	const failures: RefreshFailureDetail[] = [];
	let pendingError: unknown;
	const preLoop = upstream.failures.length;
	let consumed = preLoop;
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
				const fetchedOpenIds = new Set(result.raw.map((item) => String(item.id)));
				for (const item of result.raw) merged.set(String(item.id), item);
				const expectedOpen =
					dimension === "issues"
						? count(object(raw.openIssues).totalCount)
						: count(object(raw.openPrs).totalCount);
				const collectedOpen = result.raw.filter((row) => row.state === "OPEN").length;
				if (
					result.inventoryComplete === true &&
					expectedOpen !== null &&
					collectedOpen !== expectedOpen
				) {
					result = {
						...result,
						inventoryComplete: false,
						status: result.status === "complete" ? "partial" : result.status,
						reason: result.reason ?? "inventory_count_mismatch",
					};
				}
				if (result.inventoryComplete === true) {
					if (lifecycleRaw) {
						mergeLifecycleRaw(
							merged,
							dimension === "prs" ? lifecycleRaw.merged : lifecycleRaw.closed,
							dimension,
						);
					}
					dropStaleOpen(merged, fetchedOpenIds);
					if (expectedOpen !== null) {
						const openInMerged = [...merged.values()].filter((row) => row.state === "OPEN").length;
						if (openInMerged !== expectedOpen) {
							result = {
								...result,
								inventoryComplete: false,
								status: result.status === "complete" ? "partial" : result.status,
								reason: result.reason ?? "inventory_count_mismatch",
							};
						}
					}
				} else if (lifecycleRaw) {
					mergeLifecycleRaw(
						merged,
						dimension === "prs" ? lifecycleRaw.merged : lifecycleRaw.closed,
						dimension,
					);
				}
				const lifecycle = lifecycleRaw ? lifecycleEvents(lifecycleRaw, dimension) : [];
				if (lifecycleRaw?.truncated && result.status === "complete") {
					result = {
						...result,
						status: "partial",
						reason: result.reason ?? "lifecycle_search_truncated",
					};
				}
				writes.push(
					db
						.prepare(
							`INSERT INTO refresh_items(account_id,repo_id,stream,item_id,payload) SELECT ?,?,?,json_extract(value,'$.id'),value FROM json_each(?) WHERE 1 ON CONFLICT(account_id,repo_id,stream,item_id) DO UPDATE SET payload=excluded.payload`,
						)
						.bind(
							context.account.id,
							saved.repo_id,
							dimension,
							JSON.stringify([...merged.values()]),
						),
				);
				result = {
					...result,
					lifecycle,
					raw: [...merged.values()],
					items: [...merged.values()].map(event),
				};
			} else if (dimension === "releases")
				result = collectReleases(object(raw.releases), denied, windowOf(context).since);
			else result = await collectRest(context, upstream, saved.repo, dimension);
		} catch (error) {
			result = failure(error);
			if (terminal(error)) pendingError = error;
		}
		results.set(dimension, result);
		for (const failure of upstream.failures.slice(consumed))
			failures.push(failure.dimension === null ? { ...failure, dimension } : failure);
		consumed = upstream.failures.length;
		for (const day of context.days) {
			if (!dayNeedsRefresh(context, previous, day, dimension)) continue;
			const streamEvents = [...result.items];
			for (const item of result.lifecycle ?? []) {
				if (!streamEvents.some((existing) => existing.id === item.id)) streamEvents.push(item);
			}
			const items =
				dimension === "alerts"
					? result.items
					: dimension === "releases"
						? result.items.filter((item) => inDay(item.at, day.since, day.until))
						: dayItems(streamEvents, day.since, day.until);
			const unavailableTerminal = result.terminal === true;
			const { status, reason, count } = observationForDay(
				result,
				dimension,
				day,
				context,
				items,
				unavailableTerminal,
			);
			observations.push({
				day: day.date,
				dimension,
				status,
				payload: JSON.stringify({
					count,
					observed: items.length,
					items,
					source: result.source,
					reason,
					unavailable: unavailableTerminal && result.status === "unavailable",
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
	const retainedDays = publicationDays(context, [...current.values()]);
	const latestAlert = [...current.values()]
		.filter((row) => row.dimension === "alerts")
		.sort(
			(first, second) =>
				second.fetched_at.localeCompare(first.fetched_at) || second.day.localeCompare(first.day),
		)[0];
	const latestAlertPayload = latestAlert
		? (JSON.parse(latestAlert.payload) as { since: string; until: string; items: FactoryEvent[] })
		: null;
	const dimensions = REFRESH_DIMENSIONS.filter(
		(dimension) =>
			context.run.params.dimensions.includes(dimension) ||
			previous.some((row) => row.dimension === dimension),
	);
	for (const dimension of dimensions) {
		const { coverage } = dayCoverage(
			context,
			dimension,
			retainedDays,
			current,
			results.get(dimension),
			needed,
		);
		const { inventoryComplete } = coverage;
		const alertDays =
			latestAlert && latestAlertPayload
				? [
						{
							date: latestAlert.day,
							since: latestAlertPayload.since,
							until: latestAlertPayload.until,
						},
					]
				: [];
		const detailCoverage =
			dimension === "alerts"
				? dayCoverage(context, dimension, alertDays, current, results.get(dimension), needed)
						.coverage
				: coverage;
		repo.coverage[dimension] =
			dimension === "alerts"
				? {
						...detailCoverage,
						completeWindows: coverage.completeWindows,
						availableWindows: coverage.availableWindows ?? [],
					}
				: coverage;
		const items = new Map<string, FactoryEvent>(
			dimension === "alerts"
				? (latestAlertPayload?.items ?? []).map((item) => [item.id, item])
				: [],
		);
		const streamInventory =
			dimension === "issues" || dimension === "prs" ? (results.get(dimension)?.items ?? []) : null;
		if (streamInventory) {
			for (const item of streamInventory) items.set(item.id, item);
			for (const item of results.get(dimension)?.lifecycle ?? []) items.set(item.id, item);
		}
		for (const day of retainedDays) {
			const row = current.get(`${day.date}:${dimension}`);
			if (!row) continue;
			const value = JSON.parse(row.payload) as { count: number | null; items: FactoryEvent[] };
			if (dimension !== "alerts") for (const item of value.items) items.set(item.id, item);
			if (row.status !== "complete") continue;
			const dayBounds = retainedDays.find((entry) => entry.date === row.day);
			if (!dayBounds) continue;
			const metrics = repo.metrics.days[row.day] ?? blankDay();
			if (dimension === "commits") {
				metrics.commits = Number(value.count);
				repo.metrics.commits += Number(value.count);
			}
			const metricItems =
				dimension === "issues" || dimension === "prs" ? [...items.values()] : value.items;
			const lifecycleMetric = results.get(dimension)?.lifecycle ?? [];
			for (const item of lifecycleMetric) {
				if (dimension === "issues" && inDay(item.closedAt, dayBounds.since, dayBounds.until))
					metrics.issueClosed++;
				if (dimension === "prs" && inDay(item.mergedAt, dayBounds.since, dayBounds.until))
					metrics.prMerged++;
			}
			for (const item of metricItems) {
				if (dimension === "issues") {
					if (inDay(item.createdAt, dayBounds.since, dayBounds.until)) metrics.issueOpened++;
				}
				if (dimension === "prs") {
					if (inDay(item.createdAt, dayBounds.since, dayBounds.until)) metrics.prOpened++;
					else if (inDay(item.closedAt, dayBounds.since, dayBounds.until)) metrics.prClosed++;
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
			items:
				dimension === "issues" || dimension === "prs"
					? (streamInventory ?? [...items.values()])
					: [...items.values()],
			next: null,
			ranges: detailCoverage.completeWindows,
			coverage: detailCoverage,
		};
		if (dimension === "alerts") repo.metrics.alerts = resource.items.length;
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
						truncated:
							dimension === "alerts"
								? result.truncated === true
								: dimension === "actions"
									? result.truncated === true
									: result.status !== "complete" || inventoryComplete === false,
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
	const fetchedAt =
		[...current.values()]
			.filter((row) => row.status !== "unavailable")
			.map((row) => row.fetched_at)
			.concat(repo.metadataAt ? [repo.metadataAt] : [])
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
		...dayStatements(db, context, saved.repo_id, observations),
		db
			.prepare(
				"INSERT INTO refresh_repository_publications(account_id,repo_id,payload,fetched_at) VALUES(?,?,?,?) ON CONFLICT(account_id,repo_id) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
			)
			.bind(context.account.id, saved.repo_id, JSON.stringify(repo), context.now),
	);
	if (metadataQuery)
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
	await publish(db, context, writes, { updateFactorySnapshot: pendingError === undefined });
	const reasons = context.run.params.dimensions.flatMap((dimension) => {
		const { coverage, settled } = dayCoverage(
			context,
			dimension,
			context.days,
			current,
			results.get(dimension),
			needed,
		);
		const code =
			results.get(dimension)?.reason ??
			coverage.reason ??
			(coverage.status === "unavailable" ? "unavailable" : "partial");
		return [
			...(coverage.status === "complete" || settled ? [] : [`${dimension}:${code}`]),
			...(coverage.inventoryComplete === false ? [`${dimension}:inventory_incomplete`] : []),
		];
	});
	context.onFailures?.(
		attributedFailures([...upstream.failures.slice(0, preLoop), ...failures], needed, results),
	);
	if (pendingError) throw pendingError;
	return {
		requests: upstream.client.count,
		requestBreakdown: upstream.breakdown(),
		partial: reasons.length > 0,
		reasons,
	};
}
