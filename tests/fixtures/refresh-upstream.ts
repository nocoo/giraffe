import { vi } from "vitest";
import {
	contributionCalendarChunkWindows,
	contributionWindow,
} from "../../apps/web/src/server/lib/refresh-calendar";
import { annualContributionCalendar } from "./contribution-calendar";
import {
	isAccountFixture,
	isCalendarFixture,
	isRepositoryFixture,
	takeQueueEntry,
} from "./refresh-upstream-queue";

export const accountCalendarGraphqlRequests = (at: string, catalogPages = 1) =>
	catalogPages + contributionCalendarChunkWindows(contributionWindow(at), "Asia/Shanghai").length;

export function contributionCalendarPage(calendar: unknown, at: string) {
	return {
		viewer: {
			contributionsCollection: {
				restrictedContributionsCount: 0,
				contributionCalendar: calendar,
			},
		},
		rateLimit: { remaining: 4999, resetAt: at },
	};
}

export const calendarGraphqlFailure = () =>
	Response.json({
		data: null,
		errors: [
			{
				type: "FORBIDDEN",
				path: ["viewer", "contributionsCollection", "contributionCalendar"],
				message: "denied",
			},
		],
	});

export const calendarGraphqlFailures = (
	at: string,
	count = contributionCalendarChunkWindows(contributionWindow(at), "Asia/Shanghai").length,
) => Array.from({ length: count }, () => calendarGraphqlFailure());

type RefreshUpstreamOptions = {
	now: string;
	graphql?: unknown[];
	rest?: Record<string, unknown>;
};

export function installRefreshUpstream({ now, graphql = [], rest = {} }: RefreshUpstreamOptions) {
	const queue = [...graphql];
	let pinnedContribution: unknown | undefined;
	const lastRepoNode = () =>
		[...graphql].reverse().find((entry) => entry && typeof entry === "object" && "node" in entry);
	const fetch = vi.fn(async (input: string, init?: RequestInit) => {
		if (input.endsWith("/graphql")) {
			const body = typeof init?.body === "string" ? init.body : "";
			if (body.includes("query RefreshContributionCalendar")) {
				if (
					pinnedContribution &&
					typeof pinnedContribution === "object" &&
					"viewer" in pinnedContribution
				) {
					const payload =
						"rateLimit" in pinnedContribution
							? pinnedContribution
							: {
									...(pinnedContribution as Record<string, unknown>),
									rateLimit: { remaining: 4999, resetAt: now },
								};
					return Response.json({ data: payload });
				}
				const chunkResponse = await takeQueueEntry(queue, isCalendarFixture);
				if (chunkResponse instanceof Response) return chunkResponse.clone();
				if (chunkResponse && typeof chunkResponse === "object" && "viewer" in chunkResponse) {
					pinnedContribution = chunkResponse;
					const payload =
						"rateLimit" in chunkResponse
							? chunkResponse
							: {
									...(chunkResponse as Record<string, unknown>),
									rateLimit: { remaining: 4999, resetAt: now },
								};
					return Response.json({ data: payload });
				}
				return Response.json({
					data: {
						viewer: {
							contributionsCollection: {
								restrictedContributionsCount: 0,
								contributionCalendar: annualContributionCalendar(now, 2).calendar,
							},
						},
						rateLimit: { remaining: 4999, resetAt: now },
					},
				});
			}
			if (body.includes("query RefreshRepository")) {
				const data =
					(await takeQueueEntry(queue, isRepositoryFixture)) ??
					(queue.length > 0 ? queue.shift() : lastRepoNode());
				if (data instanceof Error) throw data;
				if (data instanceof Response) return data.clone();
				const payload =
					data && typeof data === "object" && "node" in data && !("rateLimit" in data)
						? {
								...(data as Record<string, unknown>),
								rateLimit: { remaining: 4999, resetAt: now },
							}
						: data;
				return Response.json({ data: payload });
			}
			const data =
				(await takeQueueEntry(queue, isAccountFixture)) ??
				(queue.length > 0 ? queue.shift() : graphql.at(-1));
			if (data instanceof Error) throw data;
			if (data instanceof Response) return data.clone();
			const payload =
				data && typeof data === "object" && "node" in data && !("rateLimit" in data)
					? {
							...(data as Record<string, unknown>),
							rateLimit: { remaining: 4999, resetAt: now },
						}
					: data;
			return Response.json({ data: payload });
		}
		for (const [suffix, data] of Object.entries(rest))
			if (input.includes(suffix))
				return data instanceof Response ? data.clone() : Response.json(data);
		if (input.includes("/actions/runs"))
			return Response.json({ total_count: 0, workflow_runs: [] });
		return Response.json([]);
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
