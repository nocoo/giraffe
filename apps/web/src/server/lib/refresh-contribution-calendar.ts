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
import type { CollectionContext } from "./refresh-collection-contract";

type GraphqlRequest = <Result>(
	operation: (client: GithubClient) => Promise<Result>,
	dimension?: string,
) => Promise<Result>;

type ContributionDay = NonNullable<FactorySnapshot["contribution"]>["days"][number];

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
}> {
	const timezone = context.run.params.timezone;
	const chunks = contributionCalendarChunkWindows(calendarWindow, timezone);
	const fetched: Array<{ date: string; count: number }> = [];
	const failedRanges: RefreshCalendarWindow[] = [];
	let restricted: number | null = null;
	for (const chunk of chunks) {
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
			fetched.push(...parsed.days);
		} catch (error) {
			if (
				!(
					error instanceof TruncatedError ||
					(error instanceof ApiError && error.code === "github_error")
				)
			)
				throw error;
			failedRanges.push(chunk);
		}
	}
	const rawObserved = [...new Map(fetched.map((day) => [day.date, day])).values()].sort(
		(left, right) => left.date.localeCompare(right.date),
	);
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
	};
}
