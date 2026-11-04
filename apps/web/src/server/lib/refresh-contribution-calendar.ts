import type { FactorySnapshot } from "../../lib/factory-types";
import { ApiError } from "./errors";
import type { GithubClient } from "./github-client";
import { TruncatedError } from "./github-client";
import {
	contributionCalendarChunkWindows,
	materializeContributionDays,
	mergeChunkedContributionDays,
	type RefreshCalendarWindow,
} from "./refresh-calendar";
import { count, nodes, object, text } from "./refresh-collection/model";
import { contributionCalendarQuery } from "./refresh-collection/queries";
import { type TransportFailure, transportFailure } from "./refresh-collection/transport";
import type { CollectionContext } from "./refresh-collection-contract";
import { calendarDayBounds } from "./refresh-params";

type GraphqlRequest = <Result>(
	operation: (client: GithubClient) => Promise<Result>,
	dimension?: string,
) => Promise<Result>;

type ContributionDay = NonNullable<FactorySnapshot["contribution"]>["days"][number];

export type ContributionChunkFailure = {
	code:
		| "contributions:chunk_empty"
		| "contributions:chunk_github_error"
		| "contributions:chunk_truncated";
	chunk: RefreshCalendarWindow;
	detail: TransportFailure | null;
};

const parseCalendarDays = (data: unknown) => {
	const contributions = object(
		object(object(object(data).viewer).contributionsCollection).contributionCalendar,
	);
	return {
		restricted: count(
			object(object(object(data).viewer).contributionsCollection).restrictedContributionsCount,
		),
		days: nodes(contributions.weeks).flatMap((week) =>
			nodes(week.contributionDays).flatMap((day) => {
				const countValue = count(day.contributionCount);
				const date = text(day.date);
				return countValue === null || !date ? [] : [{ date, count: Number(countValue) }];
			}),
		),
	};
};

export function dedupeChunkContributionDays(
	chunks: RefreshCalendarWindow[],
	timezone: string,
	entries: Array<{ date: string; count: number; chunkIndex: number }>,
): Array<{ date: string; count: number }> {
	const ranked = new Map<
		string,
		{ date: string; count: number; chunkIndex: number; rank: number }
	>();
	for (const entry of entries) {
		const chunk = chunks[entry.chunkIndex];
		if (!chunk) continue;
		const bounds = calendarDayBounds(entry.date, timezone);
		const fullyInside = bounds.since >= chunk.since && bounds.until <= chunk.until ? 1_000_000 : 0;
		const rank = fullyInside + entry.chunkIndex;
		const prior = ranked.get(entry.date);
		if (!prior || entry.chunkIndex > prior.chunkIndex || rank > prior.rank)
			ranked.set(entry.date, { ...entry, rank });
	}
	return [...ranked.values()]
		.sort((left, right) => left.date.localeCompare(right.date))
		.map(({ date, count }) => ({ date, count }));
}

const chunkFailureDetail = (error: unknown): TransportFailure | null => transportFailure(error);

export async function collectContributionCalendar(
	context: CollectionContext,
	calendarWindow: RefreshCalendarWindow,
	priorDays: Array<{ date: string; count: number }> | undefined,
	request: GraphqlRequest,
): Promise<{
	rawObserved: Array<{ date: string; count: number }>;
	materializedDays: ContributionDay[];
	partial: boolean;
	failedRanges: RefreshCalendarWindow[];
	restricted: number | null;
	retainPrior: boolean;
	chunkFailures: ContributionChunkFailure[];
}> {
	const timezone = context.run.params.timezone;
	const chunks = contributionCalendarChunkWindows(calendarWindow, timezone);
	const fetched: Array<{ date: string; count: number; chunkIndex: number }> = [];
	const failedRanges: RefreshCalendarWindow[] = [];
	const chunkFailures: ContributionChunkFailure[] = [];
	let restricted: number | null = null;
	for (const [chunkIndex, chunk] of chunks.entries()) {
		try {
			const data = await request(
				(github) =>
					github.githubGraphql(context.token, contributionCalendarQuery, {
						since: chunk.since,
						until: chunk.until,
					}),
				"contributions",
			);
			const parsed = parseCalendarDays(data);
			restricted = parsed.restricted ?? restricted;
			if (parsed.days.length === 0) {
				failedRanges.push(chunk);
				chunkFailures.push({ code: "contributions:chunk_empty", chunk, detail: null });
				continue;
			}
			for (const day of parsed.days) fetched.push({ ...day, chunkIndex });
		} catch (error) {
			const detail = chunkFailureDetail(error);
			if (error instanceof TruncatedError) {
				failedRanges.push(chunk);
				chunkFailures.push({ code: "contributions:chunk_truncated", chunk, detail });
				continue;
			}
			if (error instanceof ApiError && error.code === "github_error") {
				failedRanges.push(chunk);
				chunkFailures.push({ code: "contributions:chunk_github_error", chunk, detail });
				continue;
			}
			throw error;
		}
	}
	let rawObserved = dedupeChunkContributionDays(chunks, timezone, fetched);
	const allChunksFailed = chunks.length > 0 && failedRanges.length === chunks.length;
	if (rawObserved.length === 0 && priorDays?.length && allChunksFailed) {
		return {
			rawObserved: [],
			materializedDays: [],
			partial: true,
			failedRanges,
			restricted,
			retainPrior: true,
			chunkFailures,
		};
	}
	if (rawObserved.length === 0) {
		try {
			const data = await request(
				(github) =>
					github.githubGraphql(context.token, contributionCalendarQuery, {
						since: calendarWindow.since,
						until: calendarWindow.until,
					}),
				"contributions",
			);
			const parsed = parseCalendarDays(data);
			restricted = parsed.restricted ?? restricted;
			if (parsed.days.length > 0) {
				rawObserved = [...new Map(parsed.days.map((day) => [day.date, day])).values()].sort(
					(left, right) => left.date.localeCompare(right.date),
				);
				return {
					rawObserved,
					materializedDays:
						materializeContributionDays(context.now, calendarWindow, rawObserved) ?? [],
					partial: true,
					failedRanges,
					restricted,
					retainPrior: false,
					chunkFailures,
				};
			}
		} catch (error) {
			if (
				!(
					error instanceof TruncatedError ||
					(error instanceof ApiError && error.code === "github_error")
				)
			)
				throw error;
		}
		if (priorDays?.length) {
			return {
				rawObserved: [],
				materializedDays: [],
				partial: true,
				failedRanges,
				restricted,
				retainPrior: true,
				chunkFailures,
			};
		}
		return {
			rawObserved: [],
			materializedDays: [],
			partial: true,
			failedRanges: allChunksFailed ? failedRanges : failedRanges,
			restricted,
			retainPrior: false,
			chunkFailures,
		};
	}
	const materializedDays = failedRanges.length
		? mergeChunkedContributionDays(
				calendarWindow,
				context.now,
				priorDays,
				rawObserved,
				failedRanges,
			).days
		: (materializeContributionDays(context.now, calendarWindow, rawObserved) ?? []);
	return {
		rawObserved,
		materializedDays,
		partial: failedRanges.length > 0,
		failedRanges,
		restricted,
		retainPrior: false,
		chunkFailures,
	};
}
