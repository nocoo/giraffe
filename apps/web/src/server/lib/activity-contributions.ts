import type { ActivityContributions, ActivityCoverage } from "../../lib/activity-types";
import type { FactorySnapshot } from "../../lib/factory-types";
import { unknownActivity } from "./activity";
import { calendarDayBounds } from "./refresh-params";

const emptyContributionTypes = () => ({
	commits: null,
	issues: null,
	pullRequests: null,
	pullRequestReviews: null,
	restricted: null,
	repositories: null,
});

export function activityContributionsCoverage(publication: FactorySnapshot): ActivityCoverage {
	if (!publication.contribution?.days?.length)
		return unknownActivity("native_calendar_has_no_activity_attribution");
	const status = publication.contributionStatus;
	if (status === "complete") return { status: "complete", truncated: false, reason: null };
	if (status === "partial")
		return { status: "partial", truncated: false, reason: "contribution_calendar_partial" };
	return { status: "unavailable", truncated: false, reason: "contribution_calendar_unavailable" };
}

export function projectActivityContributions(
	publication: FactorySnapshot,
): ActivityContributions | null {
	const contribution = publication.contribution;
	if (!contribution?.days?.length) return null;
	const summary = activityContributionsCoverage(publication);
	const dayCoverage = (
		day: NonNullable<FactorySnapshot["contribution"]>["days"][number],
	): ActivityCoverage => {
		if (day.breakdown === "complete") return { status: "complete", truncated: false, reason: null };
		if (day.partial)
			return { status: "partial", truncated: false, reason: "contribution_day_partial" };
		return summary;
	};
	return {
		timezone: "Asia/Shanghai",
		days: contribution.days.map((day) => {
			const bounds = calendarDayBounds(day.date, "Asia/Shanghai");
			return {
				date: day.date,
				since: bounds.since,
				until: bounds.until,
				partial: day.partial ?? contribution.partial ?? false,
				count: day.count,
				types: day.types ?? emptyContributionTypes(),
				coverage: dayCoverage(day),
				nativeCalendar: {
					timezone: "github",
					total: contribution.total ?? null,
					days: [{ date: day.date, count: day.count }],
				},
			};
		}),
	};
}
