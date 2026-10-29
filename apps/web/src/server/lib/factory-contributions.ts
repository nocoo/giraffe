import { z } from "zod";
import type { FactorySnapshot } from "../../lib/factory-types";

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
