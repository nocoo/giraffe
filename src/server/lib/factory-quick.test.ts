import { expect, it } from "vitest";
import { github, memoryStore, NOW, rawEvent, ready } from "../../../tests/fixtures/factory";
import type { FactoryStreamName } from "../../lib/factory-types";
import { stepFactory, streamKey } from "./factory-collect";
import { mapFactoryEvents } from "./factory-map";

function setup(stream: FactoryStreamName = "issues") {
	const state = ready(stream);
	const repo = state.repos[0];
	if (!repo) throw new Error("fixture");
	const baseline = {
		head: "old",
		window: state.window,
		data: {
			runId: "previous",
			items: mapFactoryEvents(stream, [rawEvent(1), rawEvent(2)]),
			next: null,
			ranges: [],
			coverage: { ...repo.coverage[stream], status: "complete" as const, fetchedAt: NOW },
		},
	};
	const store = { ...memoryStore(), baseline: async () => structuredClone(baseline) };
	return { state, baseline, store, read: () => store.read(streamKey(repo.name, stream)) };
}
it("merges the whole first overlapping page with fresh states winning", async () => {
	const s = setup();
	const gh = github(() =>
		Response.json([rawEvent(3), { ...rawEvent(1), state: "closed" }], {
			headers: { link: '<https://api.github.com/repos/nocoo/app/issues?page=2>; rel="next"' },
		}),
	);
	await stepFactory(s.state, gh, "test", s.store, NOW);
	const data = await s.read();
	expect(data?.next).toBeNull();
	expect(data?.items.map((e) => e.id).sort()).toEqual(["N_1", "N_2", "N_3"]);
	expect(data?.items.find((e) => e.id === "N_1")?.state).toBe("closed");
	expect(data?.coverage.strategy).toBe("incremental");
	expect(gh.count).toBe(1);
});
it("resumes older pages until overlap, without treating newly fetched duplicates as overlap", async () => {
	const s = setup();
	let page = 0;
	const gh = github(() =>
		Response.json(page++ === 0 ? [rawEvent(3)] : [rawEvent(3), rawEvent(1)], {
			headers: {
				link: `<https://api.github.com/repos/nocoo/app/issues?page=${page + 1}>; rel="next"`,
			},
		}),
	);
	await stepFactory(s.state, gh, "test", s.store, NOW);
	expect((await s.read())?.next).toContain("page=2");
	await stepFactory(s.state, gh, "test", s.store, NOW);
	expect((await s.read())?.items).toHaveLength(3);
	expect((await s.read())?.next).toBeNull();
});
it("reconciles deletions when reaching the end and bootstraps incomplete baselines", async () => {
	for (const complete of [true, false]) {
		const s = setup();
		if (!complete) s.baseline.data.coverage.status = "partial" as "complete";
		const gh = github(() => Response.json([rawEvent(3)]));
		await stepFactory(s.state, gh, "test", s.store, NOW);
		expect((await s.read())?.items.map((e) => e.id)).toEqual(["N_3"]);
		expect((await s.read())?.coverage.strategy).toBe("full");
	}
});
it("reuses pinned evidence only for the same head and rolls the metric window forward", async () => {
	for (const stream of ["commits", "dependencies"] as const) {
		const s = setup(stream);
		s.baseline.head = "abc";
		const gh = github(() => {
			throw new Error("unexpected upstream call");
		});
		await stepFactory(s.state, gh, "test", s.store, NOW);
		expect(gh.count).toBe(0);
		expect((await s.read())?.coverage).toMatchObject({ strategy: "reused", sourceFetchedAt: NOW });
	}
});
it("does not reuse evidence outside its original window or merge open-only security lists", async () => {
	for (const stream of ["actions", "alerts"] as const) {
		const s = setup(stream);
		s.baseline.window = { since: NOW, until: NOW };
		const gh = github(() =>
			Response.json(stream === "actions" ? { total_count: 0, workflow_runs: [] } : []),
		);
		await stepFactory(s.state, gh, "test", s.store, NOW);
		expect((await s.read())?.items).toEqual([]);
		expect(gh.count).toBe(1);
	}
});
