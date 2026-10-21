import { expect, it } from "vitest";
import { github, NOW, rawEvent } from "../../../../../tests/fixtures/factory";
import { prSnapshot } from "../../lib/pull-request";
import { collectKind } from "./collect";
import { mapFactoryEvents } from "./factory-map";
import { mapPullRequests } from "./github-map";

it.each([
	["OPEN", "open"],
	["CLOSED", "closed"],
	["MERGED", "merged"],
] as const)("keeps %s lifecycle state consistent across PR collectors", (upstream, expected) => {
	expect(mapPullRequests([{ state: upstream }])[0]).toMatchObject({ state: expected });
	expect(
		mapFactoryEvents("prs", [
			{
				...rawEvent(),
				state: expected === "merged" ? "closed" : expected,
				merged_at: expected === "merged" ? NOW : null,
			},
		])[0],
	).toMatchObject({ state: expected });
});

it.each(["prs", "repo:nocoo/app:prs"])("retains open state from the %s search", async (kind) => {
	const gh = github((_url, init) => {
		const body = JSON.parse(String(init?.body)) as { query: string };
		expect(body.query).toContain("url state createdAt");
		return Response.json({
			data: {
				search: {
					issueCount: 1,
					pageInfo: { hasNextPage: false },
					nodes: [{ state: "OPEN", number: 1 }],
				},
			},
		});
	});
	expect(await collectKind(gh, "fixture", kind, ["nocoo/app"])).toMatchObject({
		pull_requests: [{ number: 1, state: "open" }],
	});
});

it("reads legacy lifecycle evidence without inventing open state or rewriting rows", () => {
	const saved = {
		pull_requests: [
			{ number: 1 },
			{ number: 2, state: "OPEN" },
			{ number: 3, state: "closed", merged_at: NOW },
			{ number: 4, state: "CLOSED" },
			{ number: 5, state: "unknown" },
			{ number: 6, state: null },
			{ number: 7, state: "MERGED" },
			{ number: 8, state: "open", mergedAt: NOW },
		],
	};
	const before = structuredClone(saved);
	expect(prSnapshot(saved).pull_requests).toMatchObject([
		{ state: null },
		{ state: "open" },
		{ state: "merged" },
		{ state: "closed" },
		{ state: null },
		{ state: null },
		{ state: "merged" },
		{ state: "merged" },
	]);
	expect(saved).toEqual(before);
});
