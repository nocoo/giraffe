import { expect, it } from "vitest";
import { github, rawRepo } from "../../../../../tests/fixtures/factory";
import { makeRun } from "../../lib/factory-run";
import { collectActivitySupplement } from "./activity-collect";
import { mapFactoryEvents, mapFactoryRepo } from "./factory-map";

it.each(["issues", "prs", "releases", "alerts", "commits"] as const)(
	"preserves astral code points at every %s text boundary",
	(stream) => {
		const title = `${"a".repeat(239)}🤖tail`;
		const body = `${"b".repeat(1199)}🤖tail`;
		const event = mapFactoryEvents(stream, [
			{
				id: 1,
				sha: "head",
				title,
				body,
				commit: { message: `${title}\nsecond line`, committer: { date: "2026-10-24T00:00:00Z" } },
				security_advisory: { summary: body },
			},
		])[0];
		if (stream !== "alerts") expect(event?.title).toBe(`${"a".repeat(239)}🤖`);
		if (["issues", "prs", "alerts"].includes(stream))
			expect(event?.body).toBe(`${"b".repeat(1199)}🤖`);
	},
);

it("preserves an astral code point at the other-branch message boundary", async () => {
	const now = "2026-10-24T00:00:00.000Z";
	const run = makeRun("text", "account", "nocoo", "request", "refresh", [], now);
	run.activityWindow = { since: "2026-10-23T00:00:00.000Z", until: now, first: false, gap: false };
	const result = await collectActivitySupplement(
		run,
		mapFactoryRepo(rawRepo),
		github(() =>
			Response.json({
				data: {
					repository: {
						refs: {
							nodes: [
								{
									name: "feature",
									target: {
										oid: "head",
										history: {
											nodes: [
												{
													oid: "sha",
													committedDate: now,
													message: `${"a".repeat(239)}🤖tail\nnext`,
												},
											],
											pageInfo: { hasNextPage: false },
										},
									},
								},
							],
							pageInfo: { hasNextPage: false },
						},
						tags: { nodes: [], pageInfo: { hasNextPage: false } },
					},
				},
			}),
		),
		"fake",
		null,
	);
	expect(result.state.commits?.[0]?.message).toBe(`${"a".repeat(239)}🤖`);
});
