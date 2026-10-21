import { expect, it } from "vitest";
import { github, memoryStore, NOW, rawEvent, ready } from "../../../../../tests/fixtures/factory";
import { prSnapshot, prState } from "../../lib/pull-request";
import { collectKind } from "./collect";
import { stepFactory, streamKey } from "./factory-collect";
import { mapFactoryEvents } from "./factory-map";
import { mapPullRequests } from "./github-map";
import { observationEnvelope, observationVersion } from "./machine-observations";
import { collectPrState } from "./pr-collect";

const unknownState = { mergeable: null, mergeStateStatus: null, checks: { state: null } };
const fields = {
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
};
const knownState = { mergeable: true, mergeStateStatus: "CLEAN", checks: { state: "SUCCESS" } };

it("maps GitHub mergeability and latest-head checks without inventing unknown values", () => {
	expect(mapPullRequests([fields])[0]).toMatchObject(knownState);
	expect(mapPullRequests([{ mergeable: "CONFLICTING" }])[0]).toMatchObject({
		...unknownState,
		mergeable: false,
	});
	for (const mergeable of [undefined, "UNKNOWN", "invalid", null])
		expect(mapPullRequests([{ mergeable }])[0]).toMatchObject(unknownState);
	expect(mapFactoryEvents("prs", [rawEvent()])[0]).toMatchObject(unknownState);
});

it.each(["prs", "repo:nocoo/app:prs"])(
	"collects %s state in the existing search request",
	async (kind) => {
		const gh = github((_url, init) => {
			const body = JSON.parse(String(init?.body)) as { query: string };
			expect(body.query).toContain("mergeStateStatus");
			expect(body.query).toContain("statusCheckRollup");
			return Response.json({
				data: {
					search: {
						issueCount: 1,
						pageInfo: { hasNextPage: false },
						nodes: [{ ...fields, number: 1, repository: { nameWithOwner: "nocoo/app" } }],
					},
				},
			});
		});
		expect(await collectKind(gh, "fixture", kind, ["nocoo/app"])).toMatchObject({
			pull_requests: [knownState],
		});
		expect(gh.count).toBe(1);
	},
);

it("enriches one factory PR page in one bounded node batch and maps by id", async () => {
	const state = ready("prs");
	const store = memoryStore();
	const gh = github((url, init) => {
		if (!url.endsWith("/graphql")) return Response.json([rawEvent(1), rawEvent(2)]);
		const body = JSON.parse(String(init?.body)) as { variables: { ids: string[] } };
		expect(body.variables.ids).toEqual(["N_1", "N_2"]);
		return Response.json({
			data: {
				nodes: [
					{ id: "N_2", ...fields },
					{ id: "N_1", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
				],
				rateLimit: { remaining: 900, resetAt: NOW },
			},
		});
	});
	await stepFactory(state, gh, "fixture", store, NOW);
	expect(gh.count).toBe(2);
	expect(state.requests).toBe(2);
	expect(state.rate).toMatchObject({ remaining: 900, resource: "graphql", observedAt: NOW });
	expect(store.data.get(streamKey("nocoo/app", "prs"))?.items).toMatchObject([
		{ mergeable: false, mergeStateStatus: "DIRTY", checks: { state: null } },
		knownState,
	]);
});

it("projects old saved PR fields as null without rewriting rows or desynchronizing source hashes", async () => {
	const saved = { pull_requests: [{ number: 1 }], fetched_at: NOW };
	const before = structuredClone(saved);
	const envelope = await observationEnvelope("a", "prs", saved);
	expect(envelope.data.pull_requests).toEqual([{ number: 1, ...unknownState }]);
	expect(saved).toEqual(before);
	expect(envelope.sourceVersion).toBe(await observationVersion(envelope.data));
	expect(envelope.sourceVersion).toBe(await observationVersion(prSnapshot(saved)));
});

it("retains saved booleans and every GitHub status enum while rejecting malformed fields", async () => {
	for (const state of ["SUCCESS", "FAILURE", "PENDING", "ERROR", "EXPECTED"])
		for (const mergeable of [true, false])
			expect(prState({ mergeable, mergeStateStatus: "BLOCKED", checks: { state } })).toEqual({
				mergeable,
				mergeStateStatus: "BLOCKED",
				checks: { state },
			});
	for (const value of [
		null,
		[],
		1,
		{ mergeStateStatus: "", checks: { state: "invented" } },
		{ commits: { nodes: [null] } },
	])
		expect(prState(value)).toEqual(unknownState);
	expect(prSnapshot({ pull_requests: [null] })).toEqual({ pull_requests: [unknownState] });
	for (const data of [null, [], "value"])
		expect(await observationVersion(data)).toMatch(/^sha256:/);
});

it.each([403, 404])(
	"keeps inaccessible PR check details unknown (%s) without discarding the list",
	async (status) => {
		const state = ready("prs");
		const items = mapFactoryEvents("prs", [rawEvent()]);
		const gh = github(() => Response.json({ message: "denied" }, { status }));
		expect(await collectPrState(state, gh, "fixture", items, NOW)).toEqual(items);
	},
);

it("keeps per-node GraphQL denials unknown, handles absent rate reset and rejects malformed batches", async () => {
	const items = mapFactoryEvents("prs", [rawEvent()]);
	const state = ready("prs");
	const denied = github(() =>
		Response.json({ data: { nodes: [] }, errors: [{ type: "FORBIDDEN" }] }),
	);
	expect(await collectPrState(state, denied, "fixture", items, NOW)).toEqual(items);
	const missing = github(() => Response.json({ data: {} }));
	await expect(collectPrState(state, missing, "fixture", items, NOW)).rejects.toMatchObject({
		code: "github_error",
	});
	const limited = github(() => Response.json({}, { status: 429 }));
	await expect(collectPrState(state, limited, "fixture", items, NOW)).rejects.toMatchObject({
		code: "github_rate_limited",
	});
	const good = github(() => Response.json({ data: { nodes: [], rateLimit: { remaining: 100 } } }));
	expect(await collectPrState(state, good, "fixture", items, NOW)).toEqual(items);
	expect(state.rate?.resetAt).toBeNull();
	expect(await collectPrState(state, good, "fixture", [], NOW)).toEqual([]);
	await expect(
		collectPrState(
			state,
			good,
			"fixture",
			mapFactoryEvents(
				"prs",
				Array.from({ length: 101 }, (_, i) => rawEvent(i)),
			),
			NOW,
		),
	).rejects.toMatchObject({ code: "github_error" });
	expect(good.count).toBe(1);
});

it.each([
	[49, 900],
	[900, 49],
])("retains independent core/GraphQL reserves across PR pages (%s/%s)", async (core, graphql) => {
	const state = ready("prs");
	const store = memoryStore();
	const reset = "2026-09-16T00:00:00.000Z";
	const gh = github((url) =>
		url.endsWith("/graphql")
			? Response.json({ data: { nodes: [], rateLimit: { remaining: graphql, resetAt: reset } } })
			: Response.json([rawEvent()], {
					headers: {
						"x-ratelimit-remaining": String(core),
						"x-ratelimit-reset": String(Date.parse(reset) / 1000),
						link: '<https://api.github.com/repos/nocoo/app/pulls?page=2>; rel="next"',
					},
				}),
	);
	await stepFactory(state, gh, "fixture", store, NOW);
	expect(state.rate?.resource).toBe("graphql");
	const calls = gh.count;
	await expect(
		stepFactory(structuredClone(state), gh, "fixture", store, NOW),
	).rejects.toMatchObject({ code: "github_rate_limited", retryAt: reset });
	expect(gh.count).toBe(calls);
	const resumed = github((url) =>
		url.endsWith("/graphql")
			? Response.json({
					data: { nodes: [], rateLimit: { remaining: 900, resetAt: "2026-09-17T00:00:00Z" } },
				})
			: Response.json([rawEvent(2)], { headers: { "x-ratelimit-remaining": "900" } }),
	);
	await stepFactory(state, resumed, "fixture", store, reset);
	expect(state.repos[0]?.coverage.prs.status).toBe("complete");
});
