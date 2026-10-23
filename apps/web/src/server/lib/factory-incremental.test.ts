import { expect, it, vi } from "vitest";
import { github, memoryStore, NOW, rawEvent, ready } from "../../../../../tests/fixtures/factory";
import type { FactoryEvent, FactoryStreamData } from "../../lib/factory-types";
import { ApiError } from "./errors";
import { type FactoryStore, stepFactory, streamKey } from "./factory-collect";
import { mapFactoryEvents } from "./factory-map";

const FETCHED = "2026-09-14T22:00:00.000Z";
const OLD = "2026-09-01T00:00:00.000Z";
const CHANGED = "2026-09-15T12:00:00.000Z";

function row(id: number, updatedAt = OLD, state = "closed") {
	return {
		...rawEvent(id),
		updated_at: updatedAt,
		state: state === "merged" ? "closed" : state,
		closed_at: state === "open" ? null : updatedAt,
		merged_at: state === "merged" ? updatedAt : null,
	};
}

type Row = ReturnType<typeof row>;
type Stream = "issues" | "prs";

function setup(stream: Stream, previous: Row[], current: Row[], pageSize = 2) {
	const state = ready(stream);
	const repo = state.repos[0];
	if (!repo) throw new Error("fixture repository missing");
	const items = mapFactoryEvents(stream, previous);
	const data: FactoryStreamData = {
		runId: "published",
		items,
		next: null,
		ranges: [],
		coverage: {
			...repo.coverage[stream],
			status: "complete",
			fetchedAt: FETCHED,
			observed: items.length,
		},
	};
	const baseline = { data, head: repo.head, window: state.window };
	const store = {
		...memoryStore(),
		baseline: vi.fn<NonNullable<FactoryStore["baseline"]>>(async () => structuredClone(baseline)),
	};
	const counts = current.filter((item) => stream !== "issues" || !("pull_request" in item));
	repo.openIssues = counts.filter((item) => item.state === "open").length;
	repo.closedIssues = counts.filter((item) => item.state === "closed").length;
	repo.openPrs = repo.openIssues;
	repo.closedPrs = counts.filter((item) => item.state === "closed" && !item.merged_at).length;
	repo.mergedPrs = counts.filter((item) => item.merged_at).length;
	const rest: string[] = [];
	const graphql: string[][] = [];
	const checks = new Map<string, string>();
	const gh = github((url, init) => {
		if (url.endsWith("/graphql")) {
			const ids: string[] = JSON.parse(String(init?.body)).variables.ids;
			graphql.push(ids);
			return Response.json({
				data: {
					nodes: ids.map((id) => ({
						id,
						commits: { nodes: [{ commit: { statusCheckRollup: { state: checks.get(id) } } }] },
					})),
				},
			});
		}
		rest.push(url);
		const parsed = new URL(url);
		const page = Number(parsed.searchParams.get("page"));
		const since = parsed.searchParams.get("since");
		const selected = current
			.filter((item) => !since || Date.parse(item.updated_at) > Date.parse(since))
			.sort((first, second) => Date.parse(second.updated_at) - Date.parse(first.updated_at));
		const result = selected.slice((page - 1) * pageSize, page * pageSize);
		parsed.searchParams.set("page", String(page + 1));
		return Response.json(result, {
			headers: selected.length > page * pageSize ? { link: `<${parsed}>; rel="next"` } : {},
		});
	});
	const read = () => store.read(streamKey(repo.name, stream));
	async function step() {
		await stepFactory(state, gh, "test", store, NOW);
		return read();
	}
	async function finish() {
		const cursor = state.cursor.stream;
		for (let attempt = 0; attempt < 50 && state.cursor.stream === cursor; attempt++) await step();
		expect(state.cursor.stream).not.toBe(cursor);
		return read();
	}
	return { state, repo, store, baseline, rest, graphql, checks, gh, read, step, finish };
}

function sorted(items: FactoryEvent[] | undefined) {
	return items?.slice().sort((first, second) => first.id.localeCompare(second.id));
}

it.each(["issues", "prs"] as const)(
	"matches full %s collection and metrics while stopping before unchanged history",
	async (stream) => {
		const previous = Array.from({ length: 8 }, (_, index) => row(index + 1));
		const current = [
			{ ...row(1, CHANGED), title: "updated" },
			row(9, CHANGED, "open"),
			...previous.slice(1),
		];
		const incremental = setup(stream, previous, current);
		const full = setup(stream, previous, current);
		full.store.baseline.mockResolvedValue(null);
		const actual = await incremental.finish();
		const expected = await full.finish();
		expect(sorted(actual?.items)).toEqual(sorted(expected?.items));
		expect(incremental.repo.metrics).toEqual(full.repo.metrics);
		expect(actual?.coverage).toMatchObject({
			status: "complete",
			strategy: "incremental",
			sourceFetchedAt: FETCHED,
			observed: current.length,
		});
		expect(incremental.rest.length).toBeLessThan(full.rest.length);
		expect(new URL(incremental.rest[0] ?? "").searchParams.get("since")).toBe(
			stream === "issues" ? "2026-09-14T21:59:59.000Z" : null,
		);
	},
);

it.each(["issues", "prs"] as const)(
	"keeps %s incremental pages partial and resumes durable state",
	async (stream) => {
		const previous = Array.from({ length: 7 }, (_, index) => row(index + 1));
		const current = previous.map((item, index) =>
			index < 4 ? { ...item, updated_at: CHANGED, title: "changed" } : item,
		);
		const fixture = setup(stream, previous, current);
		const original = structuredClone(fixture.baseline);
		const first = await fixture.step();
		expect(first?.coverage).toMatchObject({
			status: "partial",
			strategy: "incremental",
			sourceFetchedAt: FETCHED,
		});
		expect(first?.next).toContain("page=2");
		fixture.store.baseline.mockRejectedValue(new Error("baseline must not be reloaded mid-stream"));
		const completed = await fixture.finish();
		expect(completed?.coverage.status).toBe("complete");
		expect(completed?.items.filter((item) => item.title === "changed")).toHaveLength(4);
		expect(fixture.baseline).toEqual(original);
		expect(fixture.store.baseline).toHaveBeenCalledOnce();
	},
);

it.each(["issues", "prs"] as const)(
	"includes %s updates at the watermark and tied PR cutoff pages",
	async (stream) => {
		const previous = [row(1), row(2), row(3, "2026-09-14T21:59:59.000Z"), row(4)];
		const current = [row(1, FETCHED), row(2, FETCHED), row(3, "2026-09-14T21:59:59.000Z"), row(4)];
		const fixture = setup(stream, previous, current, 1);
		const actual = await fixture.finish();
		const full = setup(stream, previous, current, 1);
		full.store.baseline.mockResolvedValue(null);
		const expected = await full.finish();
		if (stream === "issues") {
			expect(actual?.items.find((item) => item.id === "N_1")?.closedAt).toBe(FETCHED);
			expect(actual?.items.find((item) => item.id === "N_2")?.closedAt).toBe(FETCHED);
		} else expect(sorted(actual?.items)).toEqual(sorted(expected?.items));
		expect(actual?.coverage.status).toBe("complete");
	},
);

it.each(["issues", "prs"] as const)(
	"falls back to full %s traversal to remove deleted baseline rows",
	async (stream) => {
		const previous = [row(1), row(2), row(3), row(4), row(5)];
		const current = [row(6, CHANGED), ...previous.slice(0, 4)];
		const fixture = setup(stream, previous, current);
		const actual = await fixture.finish();
		const full = setup(stream, [], current);
		full.store.baseline.mockResolvedValue(null);
		const expected = await full.finish();
		expect(sorted(actual?.items)).toEqual(sorted(expected?.items));
		expect(actual?.coverage).toMatchObject({ status: "complete", strategy: "full" });
		expect(actual?.coverage.sourceFetchedAt).toBeUndefined();
		expect(actual?.items.some((item) => item.id === "N_5")).toBe(false);
	},
);

it.each(["issues", "prs"] as const)(
	"falls back on %s state-count mismatch even when totals match",
	async (stream) => {
		const previous = [row(1), row(2), row(3)];
		const current = [row(1, OLD, "open"), row(2), row(3)];
		const fixture = setup(stream, previous, current, 1);
		if (stream === "prs") current[0] = row(1);
		const result = await fixture.finish();
		expect(result?.coverage).toMatchObject({ status: "complete", strategy: "full" });
		if (stream === "issues")
			expect(result?.items.find((item) => item.id === "N_1")?.state).toBe("open");
	},
);

it.each(["partial", "limited", "unavailable"] as const)(
	"rejects a %s published baseline",
	async (status) => {
		const fixture = setup("issues", [row(1)], [row(2)]);
		fixture.baseline.data.coverage.status = status;
		const result = await fixture.finish();
		expect(result?.coverage.strategy).toBe("full");
		expect(result?.items.map((item) => item.id)).toEqual(["N_2"]);
		expect(new URL(fixture.rest[0] ?? "").searchParams.has("since")).toBe(false);
	},
);

it.each([null, "invalid", NOW, "2099-01-01T00:00:00.000Z"])(
	"rejects an unusable baseline fetchedAt %s",
	async (fetchedAt) => {
		const fixture = setup("issues", [row(1)], [row(1)]);
		fixture.baseline.data.coverage.fetchedAt = fetchedAt;
		expect((await fixture.finish())?.coverage.strategy).toBe("full");
	},
);

it("uses an older finite collection watermark without relabeling source freshness", async () => {
	const fixture = setup("issues", [row(1)], [row(1, "2026-09-13T12:00:00.000Z")]);
	fixture.baseline.window = { ...fixture.baseline.window, until: "2026-09-12T22:00:00.000Z" };
	const result = await fixture.finish();
	expect(new URL(fixture.rest[0] ?? "").searchParams.get("since")).toBe("2026-09-12T21:59:59.000Z");
	expect(result?.coverage).toMatchObject({ strategy: "incremental", sourceFetchedAt: FETCHED });
	expect(result?.items[0]?.closedAt).toBe("2026-09-13T12:00:00.000Z");
});

it.each(["issues", "prs"] as const)(
	"captures %s updates made during the previous multi-page publication",
	async (stream) => {
		const previous = Array.from({ length: 8 }, (_, index) => row(index + 1));
		const current = [
			{ ...row(1, "2026-09-13T12:00:00.000Z"), title: "changed during earlier scan" },
			{ ...row(2, "2026-09-13T11:00:00.000Z"), title: "also changed during earlier scan" },
			...previous.slice(2),
		];
		const fixture = setup(stream, previous, current, 1);
		fixture.baseline.window = { ...fixture.baseline.window, until: "2026-09-12T22:00:00.000Z" };
		const full = setup(stream, previous, current, 1);
		full.store.baseline.mockResolvedValue(null);
		const actual = await fixture.finish();
		const expected = await full.finish();
		expect(sorted(actual?.items)).toEqual(sorted(expected?.items));
		expect(actual?.coverage).toMatchObject({ strategy: "incremental", sourceFetchedAt: FETCHED });
		expect(fixture.rest.length).toBeLessThan(full.rest.length);
	},
);

it.each([null, "invalid", "2099-01-01T00:00:00.000Z"])(
	"rejects an explicit unusable provider watermark %s",
	async (watermark) => {
		const fixture = setup("issues", [row(1)], [row(1)]);
		fixture.baseline.window = { ...fixture.baseline.window };
		Object.assign(fixture.baseline.window, { until: watermark });
		expect((await fixture.finish())?.coverage.strategy).toBe("full");
	},
);

it("rejects retained observations, incomplete cursors and baseline rows without update timestamps", async () => {
	for (const mutation of [
		(data: FactoryStreamData) => {
			data.coverage.retained = true;
		},
		(data: FactoryStreamData) => {
			data.coverage.observation = {
				version: "older",
				source: "run",
				window: ready().window,
				refreshedAt: OLD,
				head: null,
			};
		},
		(data: FactoryStreamData) => {
			data.next = "/repos/nocoo/app/issues?page=2";
		},
		(data: FactoryStreamData) => {
			data.ranges = [ready().window];
		},
		(data: FactoryStreamData) => {
			data.coverage.observed = 4;
		},
		(data: FactoryStreamData) => {
			Object.assign(data.items[0] ?? {}, { updatedAt: null });
		},
	]) {
		const fixture = setup("issues", [row(1)], [row(1)]);
		mutation(fixture.baseline.data);
		expect((await fixture.finish())?.coverage.strategy).toBe("full");
	}
});

it.each(["closed", "merged"] as const)(
	"matches full collection after unchanged %s PR checks rerun without REST updates",
	async (state) => {
		const previous = Array.from({ length: 205 }, (_, index) => row(index + 1, OLD, state));
		const incremental = setup("prs", previous, previous, 100);
		const full = setup("prs", previous, previous, 100);
		full.store.baseline.mockResolvedValue(null);
		for (const fixture of [incremental, full]) {
			for (const item of fixture.baseline.data.items) item.checks = { state: "PENDING" };
			for (const [index, item] of previous.entries())
				fixture.checks.set(item.node_id, index % 2 ? "FAILURE" : "SUCCESS");
		}
		const actual = await incremental.finish();
		const expected = await full.finish();
		expect(sorted(actual?.items)).toEqual(sorted(expected?.items));
		expect(incremental.repo.metrics).toEqual(full.repo.metrics);
		expect(actual?.coverage).toMatchObject({ status: "complete", strategy: "incremental" });
		expect(actual?.items.every((item) => item.updatedAt === OLD)).toBe(true);
		expect(incremental.rest).toHaveLength(1);
		expect(full.rest).toHaveLength(3);
		expect(incremental.graphql.map((ids) => ids.length)).toEqual([100, 100, 5]);
		expect(full.graphql.map((ids) => ids.length)).toEqual([100, 100, 5]);
		expect(incremental.gh.count).toBe(4);
		expect(full.gh.count).toBe(6);
	},
);

it.each(["open", "closed", "merged"] as const)(
	"refreshes unchanged %s PR GraphQL state in resumable batches of at most 100",
	async (state) => {
		const previous = Array.from({ length: 205 }, (_, index) => row(index + 1, OLD, state));
		const fixture = setup("prs", previous, previous, 1);
		for (const item of fixture.baseline.data.items) item.checks = { state: "PENDING" };
		for (const item of previous) fixture.checks.set(item.node_id, "SUCCESS");
		const first = await fixture.step();
		expect(first?.coverage.status).toBe("partial");
		expect(first?.next).toBeNull();
		const restCalls = fixture.rest.length;
		const second = await fixture.step();
		expect(second?.coverage.status).toBe("partial");
		expect(fixture.rest).toHaveLength(restCalls);
		const finished = await fixture.finish();
		expect(finished?.coverage).toMatchObject({ status: "complete", strategy: "incremental" });
		expect(finished?.items.every((item) => item.checks?.state === "SUCCESS")).toBe(true);
		expect(fixture.graphql.map((ids) => ids.length)).toEqual([1, 100, 100, 4]);
	},
);

it("retries interrupted PR state batches without losing the remaining cursor", async () => {
	const previous = [row(1, OLD, "open"), row(2, OLD, "open")];
	const fixture = setup("prs", previous, previous, 1);
	await fixture.step();
	const before = await fixture.read();
	const graphql = vi
		.spyOn(fixture.gh, "githubGraphql")
		.mockRejectedValueOnce(new Error("interrupted"));
	await expect(fixture.step()).rejects.toThrow("interrupted");
	expect(await fixture.read()).toEqual(before);
	await fixture.finish();
	expect(graphql).toHaveBeenCalledTimes(2);
	expect((await fixture.read())?.coverage.status).toBe("complete");
});

it.each(["missing", "forbidden"])(
	"does not publish stale PR state after a %s GraphQL refresh",
	async (failure) => {
		const previous = [row(1, OLD, "open"), row(2, OLD, "open")];
		const fixture = setup("prs", previous, previous, 1);
		for (const item of fixture.baseline.data.items) item.checks = { state: "PENDING" };
		for (const item of previous) fixture.checks.set(item.node_id, "SUCCESS");
		await fixture.step();
		const request = vi.spyOn(fixture.gh, "githubGraphql");
		if (failure === "missing") request.mockResolvedValueOnce({ nodes: [] });
		else request.mockRejectedValueOnce(new ApiError(403, "github_forbidden", "unavailable"));
		const fallback = await fixture.step();
		expect(fallback?.coverage).toMatchObject({ status: "partial", strategy: "full" });
		expect(fallback?.items).toEqual([]);
		expect(fallback?.next).toContain("page=1");
		const result = await fixture.finish();
		expect(result?.coverage).toMatchObject({ status: "complete", strategy: "full" });
		expect(result?.items.every((item) => item.checks?.state === "SUCCESS")).toBe(true);
	},
);

it("falls back when PR state is a partial GraphQL response without nodes", async () => {
	const previous = [row(1, OLD, "open"), row(2, OLD, "open")];
	const fixture = setup("prs", previous, previous, 1);
	await fixture.step();
	fixture.gh.graphqlErrors = [{ type: "FORBIDDEN" }];
	vi.spyOn(fixture.gh, "githubGraphql").mockResolvedValueOnce({});
	const result = await fixture.step();
	expect(result?.coverage).toMatchObject({ status: "partial", strategy: "full" });
	expect(result?.items).toEqual([]);
	expect((await fixture.finish())?.coverage.status).toBe("complete");
});

it.each(["issues", "prs"] as const)(
	"falls back when new %s rows have no usable update timestamp",
	async (stream) => {
		const previous = [row(1), row(2), row(3)];
		const fixture = setup(stream, previous, previous, 1);
		vi.spyOn(fixture.gh, "githubApi").mockResolvedValueOnce(
			Response.json([{ ...row(4), updated_at: null }]),
		);
		const first = await fixture.step();
		expect(first?.coverage).toMatchObject({ status: "partial", strategy: "full" });
		expect(first?.items).toEqual([]);
		expect((await fixture.finish())?.items).toHaveLength(3);
	},
);

it.each(["issues", "prs"] as const)(
	"reconciles empty %s baselines and current repositories",
	async (stream) => {
		const fixture = setup(stream, [], []);
		expect((await fixture.finish())?.coverage).toMatchObject({
			status: "complete",
			strategy: "incremental",
			observed: 0,
		});
		expect(fixture.rest).toHaveLength(1);
	},
);

it("does not trust stale PR metadata when reaching a shorter complete REST traversal", async () => {
	const fixture = setup("prs", [row(1), row(2)], [row(1)]);
	fixture.repo.closedPrs = 2;
	const first = await fixture.step();
	expect(first?.coverage).toMatchObject({ status: "partial", strategy: "full" });
	expect((await fixture.finish())?.items.map((item) => item.id)).toEqual(["N_1"]);
});

it.each([-1, 0.5, Number.NaN])("rejects invalid current metadata counts: %s", async (count) => {
	const fixture = setup("issues", [row(1)], [row(1)]);
	fixture.repo.closedIssues = count;
	expect((await fixture.finish())?.coverage.strategy).toBe("full");
});

it("does not mistake extra unknown lifecycle rows for complete reconciled coverage", async () => {
	const fixture = setup("issues", [row(1, OLD, "invalid")], []);
	expect((await fixture.finish())?.items).toEqual([]);
	expect((await fixture.read())?.coverage.strategy).toBe("full");
});

it("rejects duplicated baseline ids and timestamps whose overlap would exceed the date range", async () => {
	for (const extreme of [false, true]) {
		const fixture = setup("issues", [row(1)], [row(1)]);
		if (extreme) fixture.baseline.data.coverage.fetchedAt = "-271821-04-20T00:00:00.000Z";
		else {
			fixture.baseline.data.items.push(...structuredClone(fixture.baseline.data.items));
			fixture.baseline.data.coverage.observed = 2;
		}
		expect((await fixture.finish())?.coverage.strategy).toBe("full");
	}
});

it("does not request a baseline for Actions or change its traversal", async () => {
	const state = ready("actions");
	const baseline: FactoryStore["baseline"] = vi.fn(async () => {
		throw new Error("unexpected baseline");
	});
	const store = { ...memoryStore(), baseline };
	await stepFactory(
		state,
		github(() => Response.json({ total_count: 0, workflow_runs: [] })),
		"test",
		store,
		NOW,
	);
	expect(baseline).not.toHaveBeenCalled();
});

it("pages past PR-only issue responses without inflating issue reconciliation counts", async () => {
	const previous = [row(1), row(2)];
	const current = [
		{ ...row(9, CHANGED), pull_request: { url: "https://api.github.com/repos/nocoo/app/pulls/9" } },
		{ ...row(1, CHANGED), title: "updated issue" },
		row(2),
	];
	const fixture = setup("issues", previous, current, 1);
	expect((await fixture.step())?.coverage).toMatchObject({
		status: "partial",
		strategy: "incremental",
	});
	const result = await fixture.finish();
	expect(result?.coverage).toMatchObject({
		status: "complete",
		strategy: "incremental",
		observed: 2,
	});
	expect(result?.items.some((item) => item.id === "N_9")).toBe(false);
	expect(result?.items.find((item) => item.id === "N_1")?.title).toBe("updated issue");
});
