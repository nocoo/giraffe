import { expect, it } from "vitest";
import type { FactorySnapshot } from "../../lib/factory-types";
import {
	activityContributionsCoverage,
	projectActivityContributions,
} from "./activity-contributions";

const publication = (
	contribution: FactorySnapshot["contribution"],
	status: FactorySnapshot["contributionStatus"],
) =>
	({
		contribution,
		contributionStatus: status,
	}) as FactorySnapshot;

it("maps factory contribution calendar into activity contributions", () => {
	const projected = projectActivityContributions(
		publication(
			{
				days: [{ date: "2026-11-03", count: 354, breakdown: "unavailable" }],
				total: 354,
				restricted: null,
				fetchedAt: "2026-11-03T00:00:00.000Z",
			},
			"partial",
		),
	);
	expect(projected?.days[0]).toMatchObject({
		date: "2026-11-03",
		count: 354,
	});
	expect(
		activityContributionsCoverage(
			publication(
				{
					days: [{ date: "2026-11-03", count: 354 }],
					total: 354,
					restricted: null,
					fetchedAt: "2026-11-03T00:00:00.000Z",
				},
				"complete",
			),
		),
	).toMatchObject({ status: "complete", reason: null });
});

it("keeps native attribution unavailable only when no calendar exists", () => {
	expect(activityContributionsCoverage(publication(null, "unavailable"))).toMatchObject({
		status: "unavailable",
		reason: "native_calendar_has_no_activity_attribution",
	});
	expect(
		activityContributionsCoverage(
			publication(
				{
					days: [{ date: "2026-11-03", count: 0 }],
					total: 0,
					restricted: null,
					fetchedAt: "2026-11-03T00:00:00.000Z",
				},
				"partial",
			),
		),
	).toMatchObject({ status: "partial", reason: "contribution_calendar_partial" });
	expect(
		activityContributionsCoverage(
			publication(
				{
					days: [{ date: "2026-11-03", count: 0 }],
					total: 0,
					restricted: null,
					fetchedAt: "2026-11-03T00:00:00.000Z",
				},
				"unavailable",
			),
		),
	).toMatchObject({ status: "unavailable", reason: "contribution_calendar_unavailable" });
	expect(projectActivityContributions(publication(null, "unavailable"))).toBeNull();
});
