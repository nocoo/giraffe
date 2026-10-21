import { z } from "zod";
import type { FactorySnapshot } from "../../lib/factory-types";
import { object, rows } from "./factory-map";
import { FACTORY_CONTRIBUTIONS_QUERY } from "./factory-queries";
import { assertFactoryReserve, recordFactoryRate } from "./factory-rate";
import type { GithubClient } from "./github-client";

export const CONTRIBUTION_BATCH_DAYS = 15;
export const CONTRIBUTION_MAX_DAYS = 90;
export const contributionDate = z.iso.date();
type Contribution = NonNullable<FactorySnapshot["contribution"]>;
type ContributionTypes = NonNullable<Contribution["days"][number]["types"]>;
const fields = {
	commits: "totalCommitContributions",
	issues: "totalIssueContributions",
	pullRequests: "totalPullRequestContributions",
	pullRequestReviews: "totalPullRequestReviewContributions",
	restricted: "restrictedContributionsCount",
	repositories: "totalRepositoryContributions",
} as const;
export const contributionTypes = (data: Record<string, unknown> = {}): ContributionTypes =>
	Object.fromEntries(
		Object.entries(fields).map(([key, field]) => [key, count(data[field])]),
	) as ContributionTypes;
const count = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function contributionDates(since: string, until: string): string[] {
	const start = Date.parse(`${since}T00:00:00.000Z`);
	const length = Math.round((Date.parse(`${until}T00:00:00.000Z`) - start) / 86_400_000) + 1;
	if (!Number.isFinite(length) || length < 1 || length > CONTRIBUTION_MAX_DAYS) return [];
	return Array.from({ length }, (_, index) =>
		new Date(start + index * 86_400_000).toISOString().slice(0, 10),
	);
}

export async function collectContributions(
	snapshot: FactorySnapshot,
	gh: GithubClient,
	token: string,
	now: string,
) {
	assertFactoryReserve(snapshot, now);
	const pending = snapshot.contribution?.typesStatus === "pending";
	const contribution = snapshot.contribution;
	const batch = pending
		? (contribution?.days.filter((day) => !day.types).slice(0, CONTRIBUTION_BATCH_DAYS) ?? [])
		: [];
	const variables: Record<string, unknown> = { owner: snapshot.owner };
	for (const [index, day] of batch.entries()) {
		variables[`from${index}`] = `${day.date}T00:00:00.000Z`;
		const end = `${day.date}T23:59:59.999Z`;
		variables[`to${index}`] = end < snapshot.window.until ? end : snapshot.window.until;
	}
	if (!pending) Object.assign(variables, snapshot.window);
	const data = await gh.githubGraphql(
		token,
		pending ? dailyQuery(batch.length) : FACTORY_CONTRIBUTIONS_QUERY,
		variables,
	);
	const rate = object(data.rateLimit);
	if (typeof rate.remaining === "number")
		recordFactoryRate(snapshot, {
			remaining: rate.remaining,
			resetAt: typeof rate.resetAt === "string" ? rate.resetAt : null,
			resource: "graphql",
			observedAt: now,
		});
	if (gh.graphqlErrors.length) {
		snapshot.contributionStatus = "unavailable";
		return;
	}
	if (!pending) {
		const collection = object(object(data.user).contributionsCollection);
		const calendar = object(collection.contributionCalendar);
		const days = rows(calendar.weeks).flatMap((week) => rows(week.contributionDays));
		const expected = contributionDates(
			snapshot.window.since.slice(0, 10),
			snapshot.window.until.slice(0, 10),
		);
		const total = count(calendar.totalContributions);
		const restricted = count(collection.restrictedContributionsCount);
		if (
			!expected.length ||
			total === null ||
			restricted === null ||
			days.length !== expected.length ||
			new Set(days.map((day) => day.date)).size !== days.length ||
			days.some(
				(day) =>
					!contributionDate.safeParse(day.date).success ||
					!expected.includes(String(day.date)) ||
					count(day.contributionCount) === null,
			) ||
			days.reduce((sum, day) => sum + Number(day.contributionCount), 0) !== total
		) {
			snapshot.contributionStatus = "unavailable";
			return;
		}
		snapshot.contribution = {
			total,
			restricted,
			fetchedAt: now,
			observedAt: now,
			partial: true,
			timezone: "github",
			typeWindowTimezone: "UTC",
			typesStatus: "pending",
			days: days
				.map((day) => ({
					date: String(day.date),
					count: Number(day.contributionCount),
					partial: day.date === snapshot.window.until.slice(0, 10),
				}))
				.sort((a, b) => a.date.localeCompare(b.date)),
		};
		return;
	}
	for (const [index, day] of batch.entries()) {
		day.types = contributionTypes(object(object(data.user)[`day${index}`]));
		day.observedAt = now;
		const values = Object.values(day.types);
		day.breakdown = values.some((value) => value === null)
			? "unavailable"
			: values.reduce<number>((sum, value) => sum + Number(value), 0) === day.count
				? "complete"
				: "mismatch";
	}
	if (contribution?.days.every((day) => day.types)) {
		contribution.typesStatus = contribution.days.every((day) => day.breakdown === "complete")
			? "complete"
			: "partial";
		snapshot.contributionStatus = "complete";
	}
}

function dailyQuery(length: number) {
	const variables = Array.from(
		{ length },
		(_, index) => `$from${index}:DateTime!,$to${index}:DateTime!`,
	).join(",");
	const collections = Array.from(
		{ length },
		(_, index) =>
			`day${index}:contributionsCollection(from:$from${index},to:$to${index}){totalCommitContributions totalIssueContributions(excludeFirst:false,excludePopular:false) totalPullRequestContributions(excludeFirst:false,excludePopular:false) totalPullRequestReviewContributions totalRepositoryContributions(excludeFirst:false) restrictedContributionsCount}`,
	).join(" ");
	return `query($owner:String!,${variables}){user(login:$owner){${collections}} rateLimit{cost remaining resetAt}}`;
}
