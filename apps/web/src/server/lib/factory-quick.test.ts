import { expect, it } from "vitest";
import { github, memoryStore, NOW, rawEvent, ready } from "../../../../../tests/fixtures/factory";
import type { FactoryStreamData, FactoryStreamName } from "../../lib/factory-types";
import { stepFactory, streamKey } from "./factory-collect";
import { mapFactoryEvents } from "./factory-map";

function setup(stream: FactoryStreamName = "issues") {
	const state = ready(stream);
	const repo = state.repos[0];
	if (!repo) throw new Error("fixture");
	const data: FactoryStreamData = {
		runId: "previous",
		items: mapFactoryEvents(stream, [rawEvent(1), rawEvent(2)]),
		next: null,
		ranges: [],
		coverage: { ...repo.coverage[stream], status: "complete", fetchedAt: NOW },
	};
	const baseline = { head: "old", window: state.window, data };
	const store = { ...memoryStore(), baseline: async () => structuredClone(baseline) };
	return { state, baseline, store, read: () => store.read(streamKey(repo.name, stream)) };
}
it.each(["issues", "prs", "actions", "releases"] as const)(
	"reconciles 101 updated %s and deletion after an overlapping first page",
	async (stream) => {
		const fixture = setup(stream);
		const previous = Array.from({ length: 102 }, (_, index) => rawEvent(index + 1));
		fixture.baseline.data.items = mapFactoryEvents(stream, previous);
		const current = previous.slice(0, 101).map((row) => ({
			...row,
			title: "updated",
			state: "closed",
			closed_at: "2026-09-14T00:00:00Z",
			merged_at: stream === "prs" ? "2026-09-14T00:00:00Z" : null,
			status: "completed",
			conclusion: "success",
			published_at: "2026-09-14T00:00:00Z",
		}));
		const endpoint = stream === "prs" ? "pulls" : stream === "actions" ? "actions/runs" : stream;
		const gh = github((url) => {
			const second = new URL(url).searchParams.get("page") === "2";
			const rows = current.slice(second ? 100 : 0, second ? 101 : 100);
			return Response.json(
				stream === "actions" ? { total_count: 101, workflow_runs: rows } : rows,
				{
					headers: second
						? {}
						: { link: `<https://api.github.com/repos/nocoo/app/${endpoint}?page=2>; rel="next"` },
				},
			);
		});
		await stepFactory(fixture.state, gh, "test", fixture.store, NOW);
		expect((await fixture.read())?.coverage).toMatchObject({ status: "partial", strategy: "full" });
		expect((await fixture.read())?.next).toContain("page=2");
		await stepFactory(fixture.state, gh, "test", fixture.store, NOW);
		const data = await fixture.read();
		expect(data?.next).toBeNull();
		expect(data?.items).toHaveLength(101);
		expect(data?.items[100]).toMatchObject({ id: "N_101", title: "updated" });
		expect(data?.items.some((row) => row.id === "N_102")).toBe(false);
		expect(data?.coverage).toMatchObject({ status: "complete", strategy: "full", pages: 2 });
		expect(gh.count).toBe(2);
		const metrics = fixture.state.repos[0]?.metrics;
		if (stream === "issues") expect(metrics?.issueClosed).toBe(101);
		if (stream === "prs") expect(metrics?.prMerged).toBe(101);
		if (stream === "actions") expect(metrics?.ciSuccess).toBe(101);
		if (stream === "releases") expect(metrics?.releases).toBe(101);
	},
);
it("resumes immutable commit pages until overlap without treating new duplicates as overlap", async () => {
	const s = setup("commits");
	const commit = (id: number) => ({
		...rawEvent(id),
		sha: `commit${id}`,
		commit: { committer: { date: "2026-09-01T00:00:00Z" } },
	});
	s.baseline.data.items = mapFactoryEvents("commits", [commit(1), commit(2)]);
	let page = 0;
	const gh = github(() =>
		Response.json(page++ === 0 ? [commit(3)] : [commit(3), commit(1)], {
			headers: {
				link: `<https://api.github.com/repos/nocoo/app/commits?page=${page + 1}>; rel="next"`,
			},
		}),
	);
	await stepFactory(s.state, gh, "test", s.store, NOW);
	expect((await s.read())?.next).toContain("page=2");
	await stepFactory(s.state, gh, "test", s.store, NOW);
	expect((await s.read())?.items).toHaveLength(3);
	expect((await s.read())?.next).toBeNull();
	expect((await s.read())?.coverage.strategy).toBe("incremental");
});
it("reconciles deletions when reaching the end and bootstraps incomplete baselines", async () => {
	for (const complete of [true, false]) {
		const s = setup();
		if (!complete) s.baseline.data.coverage.status = "partial";
		const gh = github(() => Response.json([rawEvent(3)]));
		await stepFactory(s.state, gh, "test", s.store, NOW);
		expect((await s.read())?.items.map((e) => e.id)).toEqual(["N_3"]);
		expect((await s.read())?.coverage.strategy).toBe("full");
	}
});

it("partitions capped Actions windows even when quick refresh has a complete baseline", async () => {
	const fixture = setup("actions");
	let calls = 0;
	const gh = github(() =>
		Response.json(
			calls++ === 0
				? { total_count: 1001, workflow_runs: [rawEvent(1)] }
				: { total_count: 1, workflow_runs: [{ ...rawEvent(3), conclusion: "success" }] },
		),
	);
	await stepFactory(fixture.state, gh, "test", fixture.store, NOW);
	expect((await fixture.read())?.coverage.status).toBe("partial");
	expect((await fixture.read())?.ranges).toHaveLength(1);
	await stepFactory(fixture.state, gh, "test", fixture.store, NOW);
	await stepFactory(fixture.state, gh, "test", fixture.store, NOW);
	expect((await fixture.read())?.coverage).toMatchObject({ status: "complete", strategy: "full" });
	expect((await fixture.read())?.items.map((row) => row.id)).toEqual(["N_3"]);
	expect(fixture.state.repos[0]?.metrics.ciSuccess).toBe(1);
	expect(gh.count).toBe(3);
});

it("does not turn partial access into fresh mutable baseline evidence", async () => {
	const fixture = setup();
	const previous = structuredClone(fixture.baseline);
	const gh = github((url) =>
		new URL(url).searchParams.get("page") === "2"
			? Response.json({ message: "denied" }, { status: 403 })
			: Response.json([rawEvent(1)], {
					headers: { link: '<https://api.github.com/repos/nocoo/app/issues?page=2>; rel="next"' },
				}),
	);
	await stepFactory(fixture.state, gh, "test", fixture.store, NOW);
	expect((await fixture.read())?.coverage.status).toBe("partial");
	await stepFactory(fixture.state, gh, "test", fixture.store, NOW);
	expect((await fixture.read())?.coverage.status).toBe("limited");
	expect((await fixture.read())?.items).toHaveLength(1);
	expect(fixture.baseline).toEqual(previous);
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
it.each(["1.0.0", undefined])(
	"refetches dependency evidence after a head change",
	async (version) => {
		const fixture = setup("dependencies");
		const gh = github((_url, init) => {
			expect(String(init?.body)).toContain("abc:package.json");
			return Response.json({
				data: { repository: { package: { text: JSON.stringify({ name: "app", version }) } } },
			});
		});
		await stepFactory(fixture.state, gh, "test", fixture.store, NOW);
		expect((await fixture.read())?.items).toMatchObject([
			{ title: "app", version: version ?? "", path: "package.json#name" },
		]);
		expect((await fixture.read())?.coverage).toMatchObject({
			status: "complete",
			strategy: "full",
		});
		expect(gh.count).toBe(1);
	},
);
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
