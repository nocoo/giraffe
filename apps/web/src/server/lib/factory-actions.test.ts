import { expect, it } from "vitest";
import { github, memoryStore, NOW, rawEvent, ready } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { inWindow } from "../../lib/factory";
import { makeRun } from "../../lib/factory-run";
import type { FactoryStreamData } from "../../lib/factory-types";
import { type ActivitySupplement, collectActivitySupplement } from "./activity-collect";
import { MAX_STAGED_BYTES } from "./collect";
import { createDb } from "./db/d1";
import { claimRun, fenced, saveRun, startRun } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { ApiError } from "./errors";
import { cachedActionsClient, collectActionsSnapshot, stepActions } from "./factory-actions";
import { type FactoryStore, stepFactory, streamKey } from "./factory-collect";
import { InvocationStopped } from "./factory-invocation";
import { mapFactoryEvents } from "./factory-map";
import { boundedJson } from "./factory-publish";
import { collectSitePage } from "./factory-site";
import type { GithubClient } from "./github-client";
import { mapActionRuns } from "./github-map";

async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','nocoo','encrypted','fake',?,?)",
		)
		.bind(NOW, NOW)
		.run();
	const run = makeRun(
		"actions",
		"account",
		"nocoo",
		"request",
		"refresh",
		[],
		NOW,
		[],
		["nocoo/app"],
	);
	await startRun(db, run);
	const lease = await claimRun(db, run.id, NOW);
	if (!lease) throw new Error("missing lease");
	const snapshot = ready("actions");
	snapshot.runId = run.id;
	lease.run.checkpoint = snapshot;
	const site = lease.run.steps.find((step) => step.resource === "repo:nocoo/app:actions");
	if (!site) throw new Error("missing snapshot step");
	const read = async () => {
		const row = await createDb(raw)
			.prepare(
				"SELECT payload FROM factory_resources WHERE run_id=? AND repo='nocoo/app' AND stream='actions'",
			)
			.bind(run.id)
			.first<{ payload: string }>();
		return row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
	};
	return {
		raw,
		lease,
		snapshot,
		site,
		read,
		async baseline(
			runs: Record<string, unknown>[],
			options: { id?: string; status?: string } = {},
		) {
			const previous = "previous-actions";
			const observedAt = "2026-09-14T22:00:00.000Z";
			lease.run.repoIds["nocoo/app"] = "R_1";
			await raw
				.prepare(
					"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,'account','previous',?,'{}',?,?,?)",
				)
				.bind(previous, options.status ?? "completed", observedAt, observedAt, observedAt)
				.run();
			await raw
				.prepare(
					"INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at) VALUES('account','nocoo/app',?,?,?)",
				)
				.bind(
					previous,
					JSON.stringify({ ...snapshot.repos[0], id: options.id ?? "R_1" }),
					observedAt,
				)
				.run();
			await raw
				.prepare(
					"INSERT INTO factory_repo_state(account_id,repo,version,payload) VALUES('account','nocoo/app',?,'{}')",
				)
				.bind(previous)
				.run();
			const pages = Math.max(1, Math.ceil(runs.length / 100));
			const resources: [string, unknown][] = [
				[
					"actions-source",
					{
						status: "complete",
						next: null,
						pages,
						observed: runs.length,
						expected: runs.length,
						bytes: 0,
					},
				],
			];
			for (let index = 0; index < pages; index++) {
				const encoded = JSON.stringify({
					runs: runs.slice(index * 100, (index + 1) * 100),
					next: null,
				});
				for (let offset = 0; offset < encoded.length; offset += 250_000)
					resources.push([
						`actions-source:${String(index).padStart(3, "0")}:${String(offset / 250_000).padStart(3, "0")}`,
						encoded.slice(offset, offset + 250_000),
					]);
			}
			for (const [key, value] of resources)
				await raw
					.prepare(
						"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,'nocoo/app',?,?)",
					)
					.bind(previous, key, JSON.stringify(value))
					.run();
		},
		async stream(client: GithubClient) {
			const current = createDb(raw);
			const writes: D1PreparedStatement[] = [];
			const store: FactoryStore = {
				read,
				write: async (_key, data) => {
					writes.push(
						fenced(
							current,
							lease,
							NOW,
							"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,'nocoo/app','actions',? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
							[run.id, boundedJson(data)],
						),
					);
				},
			};
			writes.push(
				...(await stepActions(current, lease, snapshot, client, "private-token", store, NOW)),
			);
			expect(writes.length).toBeLessThanOrEqual(24);
			expect(await saveRun(current, lease, writes, NOW, true)).toBe(true);
		},
		async snapshotPage(client: GithubClient) {
			const current = createDb(raw);
			const result = await collectSitePage(current, lease, site, client, "private-token", NOW);
			expect(await saveRun(current, lease, result.writes, NOW, true)).toBe(true);
			return result;
		},
	};
}

function page(runs: unknown[], next?: number, total?: number | string) {
	return Response.json(
		{ workflow_runs: runs, ...(total === undefined ? {} : { total_count: total }) },
		{
			headers: {
				"x-ratelimit-remaining": "4999",
				...(next
					? {
							link: `<https://api.github.com/repos/nocoo/app/actions/runs?per_page=100&page=${next}>; rel="next"`,
						}
					: {}),
			},
		},
	);
}

function completedRun(id: number, createdAt = "2020-01-01T00:00:00Z") {
	return {
		...rawEvent(id),
		name: "Deploy",
		status: "completed",
		conclusion: "success",
		workflow_id: 9,
		run_attempt: 1,
		head_sha: "abc",
		created_at: createdAt,
		run_started_at: createdAt,
		updated_at: createdAt,
	};
}

async function finishActions(fixture: Awaited<ReturnType<typeof setup>>, client: GithubClient) {
	for (let index = 0; index < 45; index++) {
		await fixture.stream(client);
		if ((await fixture.read())?.coverage.status === "complete") return;
	}
	throw new Error("Actions did not complete");
}

it("reconciles an incremental delta into the exact shared stream, snapshot and deployment source", async () => {
	const fixture = await setup();
	const history = Array.from({ length: 1230 }, (_, index) => completedRun(index + 1));
	const pending = {
		...completedRun(1231, "2026-09-01T00:00:00Z"),
		status: "in_progress",
		conclusion: null,
	};
	await fixture.baseline([pending, ...history]);
	const delta = [
		completedRun(1232, "2026-09-15T21:00:00Z"),
		completedRun(1231, pending.created_at),
	];
	const all = [...delta, ...history];
	const paths: string[] = [];
	const client = github((path) => {
		paths.push(path);
		const url = new URL(path);
		if (url.searchParams.has("created")) {
			expect(url.searchParams.get("created")).toBe(">=2026-08-15T21:59:59.000Z");
			return page(delta, undefined, delta.length);
		}
		const index = Number(url.searchParams.get("page") ?? 1);
		return page(
			all.slice((index - 1) * 100, index * 100),
			index < Math.ceil(all.length / 100) ? index + 1 : undefined,
			all.length,
		);
	});
	await finishActions(fixture, client);
	expect(paths).toHaveLength(2);
	expect(fixture.snapshot.requests).toBe(2);
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "complete",
		strategy: "incremental",
		observed: 2,
	});
	expect((await fixture.read())?.items).toEqual(mapFactoryEvents("actions", delta));
	const unused = github(() => {
		throw new Error("must reuse incremental source");
	});
	expect((await fixture.snapshotPage(unused)).done).toBe(true);
	expect(
		await readSnapshot(createDb(fixture.raw), "account", fixture.site.resource ?? "", "actions"),
	).toMatchObject({ truncated: false, runs: mapActionRuns({ workflow_runs: all }) });
	const cached = await cachedActionsClient(
		createDb(fixture.raw),
		fixture.lease,
		"nocoo/app",
		unused,
	);
	const response = await cached.githubApi(
		"fake",
		"/repos/nocoo/app/actions/runs?status=success&per_page=100",
	);
	expect(await response.json()).toMatchObject({
		total_count: all.length,
		workflow_runs: all.slice(0, 100),
	});
	expect(unused.count).toBe(0);
});

it.each(["stream", "snapshot"] as const)(
	"resumes bounded materialization of legal large history started by the %s lane",
	async (lane) => {
		const fixture = await setup();
		const history = Array.from({ length: 3900 }, (_, index) => ({
			...completedRun(index + 1),
			path: "x".repeat(3500),
		}));
		const recent = completedRun(3901, "2026-09-15T21:00:00Z");
		const all = [recent, ...history];
		const bytes = new TextEncoder().encode(JSON.stringify(all)).length;
		expect(bytes).toBeGreaterThan(15_000_000);
		expect(bytes).toBeLessThan(MAX_STAGED_BYTES);
		await fixture.baseline(history);
		const client = github((path) =>
			new URL(path).searchParams.has("created")
				? page([recent], undefined, 1)
				: page(all.slice(0, 100), 2, all.length),
		);
		for (let index = 0; index < 2; index++) {
			if (lane === "stream") await fixture.stream(client);
			else {
				const db = createDb(fixture.raw);
				const result = await collectActionsSnapshot(
					db,
					fixture.lease,
					"nocoo/app",
					client,
					"fake",
					NOW,
				);
				expect(result.writes.length).toBeLessThanOrEqual(20);
				expect(result.payload).toBeUndefined();
				expect(await saveRun(db, fixture.lease, result.writes, NOW, true)).toBe(true);
			}
		}
		const source = await fixture.raw
			.prepare(
				"SELECT payload FROM factory_resources WHERE run_id='actions' AND stream='actions-source'",
			)
			.first<{ payload: string }>();
		expect(JSON.parse(source?.payload ?? "null")).toMatchObject({
			status: "partial",
			pages: 0,
			next: "/repos/nocoo/app/actions/runs?per_page=100",
		});
		expect(
			(
				await fixture.raw
					.prepare(
						"SELECT stream FROM factory_resources WHERE run_id='actions' AND stream LIKE 'actions-source:%'",
					)
					.all()
			).results,
		).toEqual([]);
		const unused = github(() => {
			throw new Error("must resume without refetching");
		});
		expect(
			await cachedActionsClient(createDb(fixture.raw), fixture.lease, "nocoo/app", unused),
		).toBe(unused);
		let complete = false;
		for (let index = 0; index < 10; index++) {
			if (lane === "stream") {
				await fixture.stream(unused);
				const saved = await fixture.raw
					.prepare(
						"SELECT payload FROM factory_resources WHERE run_id='actions' AND stream='actions-source'",
					)
					.first<{ payload: string }>();
				complete = JSON.parse(saved?.payload ?? "null").status === "complete";
				if (complete) break;
				continue;
			}
			const db = createDb(fixture.raw);
			const result = await collectActionsSnapshot(
				db,
				fixture.lease,
				"nocoo/app",
				unused,
				"fake",
				NOW,
			);
			expect(result.writes.length).toBeLessThanOrEqual(20);
			if (result.payload) {
				expect(result.payload).toMatchObject({
					runs: mapActionRuns({ workflow_runs: all }),
					truncated: false,
				});
				complete = true;
			}
			expect(await saveRun(db, fixture.lease, result.writes, NOW, true)).toBe(true);
			if (complete) break;
		}
		expect(complete).toBe(true);
		expect(
			(
				await collectActionsSnapshot(
					createDb(fixture.raw),
					fixture.lease,
					"nocoo/app",
					unused,
					"fake",
					NOW,
				)
			).payload,
		).toMatchObject({
			runs: mapActionRuns({ workflow_runs: all }),
			truncated: false,
		});
		await finishActions(fixture, unused);
		expect((await fixture.read())?.items).toEqual(mapFactoryEvents("actions", [recent]));
		expect((await fixture.read())?.coverage).toMatchObject({
			status: "complete",
			strategy: "incremental",
		});
		const cached = await cachedActionsClient(
			createDb(fixture.raw),
			fixture.lease,
			"nocoo/app",
			unused,
		);
		expect(
			await (
				await cached.githubApi(
					"fake",
					"/repos/nocoo/app/actions/runs?status=success&per_page=100&page=40",
				)
			).json(),
		).toMatchObject({
			total_count: all.length,
			workflow_runs: all.slice(3900),
		});
		expect(
			(
				await fixture.raw
					.prepare(
						"SELECT stream FROM factory_resources WHERE run_id='actions' AND (stream LIKE 'actions-incremental:%' OR stream LIKE 'actions-materializing:%')",
					)
					.all()
			).results,
		).toEqual([]);
		expect(client.count).toBe(2);
		expect(unused.count).toBe(0);
	},
);

it.each(["full", "incremental"] as const)(
	"bounds writes for a legal large single %s source page without dropping raw chunks",
	async (strategy) => {
		const fixture = await setup();
		const recent = {
			...completedRun(102, "2026-09-15T21:00:00Z"),
			tag_name: "x".repeat(15_500_000),
		};
		const history =
			strategy === "incremental"
				? Array.from({ length: 101 }, (_, index) => completedRun(index + 1))
				: [];
		if (history.length) await fixture.baseline(history);
		const client = github((path) =>
			page(
				[recent],
				history.length && !new URL(path).searchParams.has("created") ? 2 : undefined,
				new URL(path).searchParams.has("created") ? 1 : history.length + 1,
			),
		);
		await finishActions(fixture, client);
		expect((await fixture.read())?.coverage).toMatchObject({ status: "complete", strategy });
		const unused = github(() => {
			throw new Error("must reuse all large chunks");
		});
		const cached = await cachedActionsClient(
			createDb(fixture.raw),
			fixture.lease,
			"nocoo/app",
			unused,
		);
		expect(
			await (
				await cached.githubApi("fake", "/repos/nocoo/app/actions/runs?status=success&per_page=100")
			).json(),
		).toMatchObject({
			total_count: history.length + 1,
			workflow_runs: [recent, ...history].slice(0, 100),
		});
		expect(client.count).toBe(strategy === "incremental" ? 2 : 1);
		expect(unused.count).toBe(0);
	},
);

it("fences the final materialization batch and resumes durable temporary chunks after lease takeover", async () => {
	const fixture = await setup();
	const history = Array.from({ length: 2000 }, (_, index) => completedRun(index + 1));
	const recent = completedRun(2001, "2026-09-15T21:00:00Z");
	await fixture.baseline(history);
	await fixture.stream(github(() => page([recent], 2, history.length + 1)));
	await fixture.stream(github(() => page([recent], undefined, 1)));
	const unused = github(() => {
		throw new Error("must resume the accepted delta");
	});
	const db = createDb(fixture.raw);
	const result = await collectActionsSnapshot(db, fixture.lease, "nocoo/app", unused, "fake", NOW);
	expect(result.payload).toMatchObject({
		runs: mapActionRuns({ workflow_runs: [recent, ...history] }),
	});
	const later = new Date(Date.parse(NOW) + 120_000).toISOString();
	const takeover = await claimRun(createDb(fixture.raw), "actions", later);
	if (!takeover) throw new Error("missing takeover lease");
	expect(await saveRun(db, fixture.lease, result.writes, later, true)).toBe(false);
	const source = await fixture.raw
		.prepare(
			"SELECT payload FROM factory_resources WHERE run_id='actions' AND stream='actions-source'",
		)
		.first<{ payload: string }>();
	expect(JSON.parse(source?.payload ?? "null")).toMatchObject({ status: "partial", pages: 0 });
	expect(
		(
			await fixture.raw
				.prepare(
					"SELECT stream FROM factory_resources WHERE run_id='actions' AND stream LIKE 'actions-source:%'",
				)
				.all()
		).results,
	).toEqual([]);
	const resumed = createDb(fixture.raw);
	const accepted = await collectActionsSnapshot(
		resumed,
		takeover,
		"nocoo/app",
		unused,
		"fake",
		later,
	);
	expect(accepted.writes.length).toBeLessThanOrEqual(20);
	expect(accepted.payload).toEqual(result.payload && { ...result.payload, fetched_at: later });
	expect(await saveRun(resumed, takeover, accepted.writes, later, true)).toBe(true);
	expect(
		(
			await collectActionsSnapshot(
				createDb(fixture.raw),
				takeover,
				"nocoo/app",
				unused,
				"fake",
				later,
			)
		).payload,
	).toEqual(accepted.payload);
	expect(unused.count).toBe(0);
});

it("ignores temporary materialization chunks when v0.23 restarts canonical unfiltered collection", async () => {
	const fixture = await setup();
	const history = Array.from({ length: 2000 }, (_, index) => completedRun(index + 1));
	const recent = completedRun(2001, "2026-09-15T21:00:00Z");
	await fixture.baseline(history);
	await fixture.stream(github(() => page([recent], 2, history.length + 1)));
	await fixture.stream(github(() => page([recent], undefined, 1)));
	const row = await fixture.raw
		.prepare(
			"SELECT payload FROM factory_resources WHERE run_id='actions' AND stream='actions-source'",
		)
		.first<{ payload: string }>();
	const source = JSON.parse(row?.payload ?? "null");
	expect(source.incremental.materializing).toBeGreaterThan(0);
	const next = "/repos/nocoo/app/actions/runs?per_page=100&page=2";
	await fixture.raw
		.prepare(
			"UPDATE factory_resources SET payload=? WHERE run_id='actions' AND stream='actions-source'",
		)
		.bind(JSON.stringify({ ...source, pages: 1, next, observed: 1, expected: 2, bytes: 0 }))
		.run();
	await fixture.raw
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('actions','nocoo/app','actions-source:000:000',?)",
		)
		.bind(JSON.stringify(JSON.stringify({ runs: [recent], next })))
		.run();
	const client = github((path) => {
		expect(new URL(path).pathname + new URL(path).search).toBe(next);
		return page([completedRun(1)], undefined, 2);
	});
	await finishActions(fixture, client);
	expect((await fixture.read())?.coverage).toMatchObject({ status: "complete", strategy: "full" });
	const unused = github(() => {
		throw new Error("must reuse the v0.23 canonical source");
	});
	expect(
		(
			await collectActionsSnapshot(
				createDb(fixture.raw),
				fixture.lease,
				"nocoo/app",
				unused,
				"fake",
				NOW,
			)
		).payload,
	).toMatchObject({
		runs: mapActionRuns({ workflow_runs: [recent, completedRun(1)] }),
	});
	expect(client.count).toBe(1);
});

it("refreshes completed reruns throughout the prior observation's 30-day eligibility window", async () => {
	const fixture = await setup();
	const old = completedRun(1);
	const rerun = completedRun(2, "2026-08-15T22:00:00Z");
	await fixture.baseline([rerun, old]);
	const updated = { ...rerun, conclusion: "failure", run_attempt: 2, updated_at: NOW };
	const client = github((path) =>
		new URL(path).searchParams.has("created")
			? page([updated], undefined, 1)
			: page([updated], 2, 2),
	);
	await finishActions(fixture, client);
	expect(client.count).toBe(2);
	await fixture.snapshotPage(
		github(() => {
			throw new Error("must reuse");
		}),
	);
	expect(
		await readSnapshot(createDb(fixture.raw), "account", fixture.site.resource ?? "", "actions"),
	).toMatchObject({ runs: mapActionRuns({ workflow_runs: [updated, old] }) });
});

it.each(["queued", "in_progress", "completed"])(
	"widens the delta for old %s runs that may still change",
	async (status) => {
		const fixture = await setup();
		const old = completedRun(1);
		const mutable = { ...completedRun(2, "2026-01-01T00:00:00Z"), status, run_started_at: NOW };
		await fixture.baseline([mutable, old]);
		const client = github((path) => {
			if (new URL(path).searchParams.has("created")) {
				expect(new URL(path).searchParams.get("created")).toBe(">=2026-01-01T00:00:00.000Z");
				return page([mutable], undefined, 1);
			}
			return page([mutable], 2, 2);
		});
		await finishActions(fixture, client);
		expect(client.count).toBe(2);
	},
);

it("falls back to full history when historical deletion breaks count reconciliation", async () => {
	const fixture = await setup();
	const history = [completedRun(1), completedRun(2)];
	const recent = completedRun(3, "2026-09-01T00:00:00Z");
	await fixture.baseline([recent, ...history]);
	const current = [completedRun(4, NOW), recent, history[0]];
	let filtered = false;
	const client = github((path) => {
		const url = new URL(path);
		if (url.searchParams.has("created")) {
			filtered = true;
			return page(current.slice(0, 2), undefined, 2);
		}
		return filtered ? page(current, undefined, 3) : page(current.slice(0, 1), 2, 3);
	});
	await finishActions(fixture, client);
	expect(client.count).toBe(3);
	expect((await fixture.read())?.coverage.strategy).toBe("full");
	await fixture.snapshotPage(
		github(() => {
			throw new Error("must reuse");
		}),
	);
	expect(
		await readSnapshot(createDb(fixture.raw), "account", fixture.site.resource ?? "", "actions"),
	).toMatchObject({ runs: mapActionRuns({ workflow_runs: current }) });
});

it("checkpoints incremental pages without exposing filtered history as a complete source", async () => {
	const fixture = await setup();
	await fixture.baseline([completedRun(1), completedRun(2, "2026-09-01T00:00:00Z")]);
	await fixture.stream(github(() => page([completedRun(3, "2026-09-15T21:00:00Z")], 2, 3)));
	await fixture.stream(github(() => page([completedRun(3, "2026-09-15T21:00:00Z")], 2, 2)));
	const source = await fixture.raw
		.prepare(
			"SELECT payload FROM factory_resources WHERE run_id='actions' AND stream='actions-source'",
		)
		.first<{ payload: string }>();
	expect(JSON.parse(source?.payload ?? "null")).toMatchObject({
		status: "partial",
		pages: 0,
		next: "/repos/nocoo/app/actions/runs?per_page=100",
	});
	const upstream = github(() => {
		throw new Error("must not request");
	});
	expect(
		await cachedActionsClient(createDb(fixture.raw), fixture.lease, "nocoo/app", upstream),
	).toBe(upstream);
	const stopped = new InvocationStopped();
	await expect(
		fixture.stream(
			github(() => {
				throw stopped;
			}),
		),
	).rejects.toBe(stopped);
	const client = github((path) => {
		expect(new URL(path).searchParams.get("created")).not.toBeNull();
		expect(new URL(path).searchParams.get("page")).toBe("2");
		return page([completedRun(2, "2026-09-01T00:00:00Z")], undefined, 2);
	});
	await finishActions(fixture, client);
	expect(client.count).toBe(1);
	expect((await fixture.read())?.coverage).toMatchObject({ strategy: "incremental", observed: 2 });
});

it("can build the incremental source from the snapshot lane before replaying all stream pages", async () => {
	const fixture = await setup();
	const history = Array.from({ length: 230 }, (_, index) => completedRun(index + 1));
	await fixture.baseline(history);
	const recent = completedRun(231, "2026-09-15T21:00:00Z");
	const probe = github(() => page([recent], 2, 231));
	expect((await fixture.snapshotPage(probe)).done).toBe(false);
	const delta = github((path) => {
		expect(new URL(path).searchParams.has("created")).toBe(true);
		return page([recent], undefined, 1);
	});
	expect((await fixture.snapshotPage(delta)).done).toBe(true);
	const unused = github(() => {
		throw new Error("must replay");
	});
	await finishActions(fixture, unused);
	expect(unused.count).toBe(0);
	expect((await fixture.read())?.items).toEqual(mapFactoryEvents("actions", [recent]));
	expect(
		await readSnapshot(createDb(fixture.raw), "account", fixture.site.resource ?? "", "actions"),
	).toMatchObject({ runs: mapActionRuns({ workflow_runs: [recent, ...history] }) });
});

it("removes deleted recent runs using the authoritative empty delta while retaining old deployments", async () => {
	const fixture = await setup();
	const history = Array.from({ length: 101 }, (_, index) => completedRun(index + 1));
	await fixture.baseline([completedRun(102, "2026-09-01T00:00:00Z"), ...history]);
	const client = github((path) =>
		new URL(path).searchParams.has("created")
			? page([], undefined, 0)
			: page(history.slice(0, 100), 2, 101),
	);
	await finishActions(fixture, client);
	expect(client.count).toBe(2);
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "complete",
		strategy: "incremental",
		observed: 0,
	});
	await fixture.snapshotPage(
		github(() => {
			throw new Error("must reuse");
		}),
	);
	expect(
		await readSnapshot(createDb(fixture.raw), "account", fixture.site.resource ?? "", "actions"),
	).toMatchObject({ runs: mapActionRuns({ workflow_runs: history }) });
});

it.each([
	["filtered search cap", () => page([], undefined, 1001)],
	["missing count", () => page([completedRun(2, "2026-09-01T00:00:00Z")])],
	["incomplete count", () => page([], undefined, 1)],
	[
		"duplicate ids",
		() =>
			page(
				[completedRun(2, "2026-09-01T00:00:00Z"), completedRun(2, "2026-09-01T00:00:00Z")],
				undefined,
				2,
			),
	],
	["invalid id", () => page([{ ...completedRun(2, "2026-09-01T00:00:00Z"), id: 0 }], undefined, 1)],
	["historical id collision", () => page([completedRun(1, "2026-09-01T00:00:00Z")], undefined, 1)],
	["out-of-range result", () => page([completedRun(2)], undefined, 1)],
] as const)("abandons the delta and restarts full collection for %s", async (_name, response) => {
	const fixture = await setup();
	const runs = [completedRun(2, "2026-09-01T00:00:00Z"), completedRun(1)];
	await fixture.baseline(runs);
	await fixture.stream(github(() => page(runs.slice(0, 1), 2, 2)));
	await fixture.stream(github(response));
	const client = github((path) => {
		expect(new URL(path).searchParams.has("created")).toBe(false);
		return page(runs, undefined, 2);
	});
	await finishActions(fixture, client);
	expect((await fixture.read())?.coverage).toMatchObject({ strategy: "full", observed: 1 });
	expect((await fixture.read())?.items).toEqual(mapFactoryEvents("actions", runs.slice(0, 1)));
});

it("abandons a drifting delta count and never repeats its accepted filtered pages", async () => {
	const fixture = await setup();
	const recent = completedRun(2, "2026-09-01T00:00:00Z");
	const runs = [recent, completedRun(1)];
	await fixture.baseline(runs);
	await fixture.stream(github(() => page([recent], 2, 2)));
	await fixture.stream(github(() => page([recent], 2, 2)));
	await fixture.stream(github(() => page([], undefined, 1)));
	const client = github((path) => {
		expect(new URL(path).searchParams.has("created")).toBe(false);
		return page(runs, undefined, 2);
	});
	await finishActions(fixture, client);
	expect(client.count).toBe(1);
	expect((await fixture.read())?.coverage.strategy).toBe("full");
	expect(
		(
			await fixture.raw
				.prepare(
					"SELECT stream FROM factory_resources WHERE run_id='actions' AND stream LIKE 'actions-incremental:%'",
				)
				.all()
		).results,
	).toEqual([]);
});

it.each([
	["different repository identity", { id: "R_recreated" }],
	["unpublished failed baseline", { status: "failed" }],
] as const)("does not use a %s", async (_name, options) => {
	const fixture = await setup();
	await fixture.baseline([completedRun(1)], options);
	await fixture.stream(
		github((path) => {
			expect(new URL(path).searchParams.has("created")).toBe(false);
			return page([], undefined, 0);
		}),
	);
	expect((await fixture.read())?.coverage.strategy).toBe("full");
});

it.each([
	["missing", null],
	["malformed", JSON.stringify({ next: null, runs: null })],
	["null", "null"],
	["invalid JSON", "{"],
] as const)("falls back to full collection for a %s baseline page", async (_name, payload) => {
	const fixture = await setup();
	await fixture.baseline([completedRun(1)]);
	if (payload === null)
		await fixture.raw
			.prepare(
				"DELETE FROM factory_resources WHERE run_id='previous-actions' AND stream LIKE 'actions-source:%'",
			)
			.run();
	else
		await fixture.raw
			.prepare(
				"UPDATE factory_resources SET payload=? WHERE run_id='previous-actions' AND stream LIKE 'actions-source:%'",
			)
			.bind(JSON.stringify(payload))
			.run();
	await fixture.stream(github(() => page([], undefined, 0)));
	expect((await fixture.read())?.coverage).toMatchObject({ status: "complete", strategy: "full" });
});

it("abandons filtered pagination at its bounded page budget", async () => {
	const fixture = await setup();
	await fixture.baseline([completedRun(1)]);
	await fixture.stream(github(() => page([completedRun(2, "2026-09-01T00:00:00Z")], 2, 101)));
	for (let index = 1; index <= 40; index++)
		await fixture.stream(
			github(() => page([completedRun(index + 1, "2026-09-01T00:00:00Z")], index + 1, 100)),
		);
	const client = github((path) => {
		expect(new URL(path).searchParams.has("created")).toBe(false);
		return page([], undefined, 0);
	});
	await finishActions(fixture, client);
	expect(client.count).toBe(1);
	expect((await fixture.read())?.coverage.strategy).toBe("full");
});

it("resumes a v0.23 shared source without changing its committed unfiltered cursor", async () => {
	const fixture = await setup();
	const recent = completedRun(2, "2026-09-01T00:00:00Z");
	expect((await fixture.snapshotPage(github(() => page([recent], 2, 2)))).done).toBe(false);
	await fixture.baseline([recent, completedRun(1)]);
	await fixture.stream(
		github(() => {
			throw new Error("must replay committed v0.23 page");
		}),
	);
	await fixture.stream(
		github((path) => {
			const url = new URL(path);
			expect(url.searchParams.get("page")).toBe("2");
			expect(url.searchParams.has("created")).toBe(false);
			return page([completedRun(1)], undefined, 2);
		}),
	);
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "complete",
		strategy: "full",
		pages: 2,
	});
	expect((await fixture.read())?.items).toEqual(mapFactoryEvents("actions", [recent]));
});

it("discards abandoned delta metadata after a v0.23 worker starts full collection", async () => {
	const fixture = await setup();
	const recent = completedRun(2, "2026-09-01T00:00:00Z");
	await fixture.baseline([recent, completedRun(1)]);
	await fixture.stream(github(() => page([recent], 2, 2)));
	await fixture.raw
		.prepare(
			"UPDATE factory_resources SET payload=json_set(payload,'$.pages',1,'$.observed',1,'$.expected',2,'$.next','/repos/nocoo/app/actions/runs?per_page=100&page=2') WHERE run_id='actions' AND stream='actions-source'",
		)
		.run();
	await fixture.raw
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('actions','nocoo/app','actions-source:000:000',?)",
		)
		.bind(
			JSON.stringify(
				JSON.stringify({
					runs: [recent],
					next: "/repos/nocoo/app/actions/runs?per_page=100&page=2",
				}),
			),
		)
		.run();
	const client = github((path) => {
		expect(new URL(path).searchParams.has("created")).toBe(false);
		expect(new URL(path).searchParams.get("page")).toBe("2");
		return page([completedRun(1)], undefined, 2);
	});
	await finishActions(fixture, client);
	expect(client.count).toBe(1);
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "complete",
		strategy: "full",
		observed: 1,
	});
});

it("fences materialized incremental pages and their source state as one checkpoint", async () => {
	const fixture = await setup();
	const recent = completedRun(2, "2026-09-01T00:00:00Z");
	await fixture.baseline([recent, completedRun(1)]);
	await fixture.stream(github(() => page([recent], 2, 2)));
	const db = createDb(fixture.raw);
	const writes = await stepActions(
		db,
		fixture.lease,
		fixture.snapshot,
		github(() => page([recent], undefined, 1)),
		"fake",
		memoryStore(),
		NOW,
	);
	const later = new Date(Date.parse(NOW) + 120_000).toISOString();
	expect(await claimRun(createDb(fixture.raw), "actions", later)).not.toBeNull();
	expect(await saveRun(db, fixture.lease, writes, later, true)).toBe(false);
	expect(
		(
			await fixture.raw
				.prepare(
					"SELECT stream FROM factory_resources WHERE run_id='actions' AND stream LIKE 'actions-source:%'",
				)
				.all()
		).results,
	).toEqual([]);
	const source = await fixture.raw
		.prepare(
			"SELECT payload FROM factory_resources WHERE run_id='actions' AND stream='actions-source'",
		)
		.first<{ payload: string }>();
	expect(JSON.parse(source?.payload ?? "null")).toMatchObject({ status: "partial", pages: 0 });
});

it.each([undefined, "2000+", 5000] as const)(
	"uses the unfiltered probe directly when its count is %s",
	async (total) => {
		const fixture = await setup();
		const recent = completedRun(2, "2026-09-01T00:00:00Z");
		await fixture.baseline([completedRun(1)]);
		await fixture.stream(github(() => page([recent], 2, total)));
		const client = github((path) => {
			expect(new URL(path).searchParams.has("created")).toBe(false);
			expect(new URL(path).searchParams.get("page")).toBe("2");
			return page([completedRun(1)]);
		});
		await fixture.stream(client);
		expect(client.count).toBe(1);
	},
);

it("shares every unfiltered page with the frozen-window stream and exact full snapshot", async () => {
	const fixture = await setup();
	const runs = [
		{
			...rawEvent(1),
			name: "CI",
			status: "completed",
			conclusion: "success",
			workflow_id: 9,
			head_sha: "abc",
			run_attempt: 2,
			run_started_at: "2026-09-01T00:00:00Z",
			updated_at: "2026-09-01T00:01:00Z",
			actor: { login: "bot" },
			path: ".github/workflows/ci.yml",
		},
		{ ...rawEvent(2), created_at: "2020-01-01T00:00:00Z" },
		{ ...rawEvent(3), created_at: NOW },
	];
	const paths: string[] = [];
	for (let index = 0; index < runs.length; index++) {
		const client = github((url) => {
			paths.push(url);
			return page([runs[index]], index < 2 ? index + 2 : undefined, 3);
		});
		await fixture.stream(client);
		expect(client.count).toBe(1);
		expect((await fixture.read())?.coverage.status).toBe(index < 2 ? "partial" : "complete");
	}
	expect(paths.every((url) => !new URL(url).searchParams.has("created"))).toBe(true);
	expect((await fixture.read())?.items).toEqual(
		mapFactoryEvents("actions", runs).filter((event) =>
			inWindow(event.at, fixture.snapshot.window),
		),
	);
	expect(fixture.snapshot.requests).toBe(3);
	expect(fixture.snapshot.rate?.remaining).toBe(4999);
	const cached = github(() => {
		throw new Error("snapshot must reuse source");
	});
	expect((await fixture.snapshotPage(cached)).done).toBe(true);
	expect(fixture.site.strategy).toBe("reused");
	expect(cached.count).toBe(0);
	expect(
		await readSnapshot(createDb(fixture.raw), "account", fixture.site.resource ?? "", "actions"),
	).toMatchObject({ truncated: false, runs: mapActionRuns({ workflow_runs: runs }) });
});

it("can derive a stream from source pages populated by a snapshot without another request", async () => {
	const fixture = await setup();
	await fixture.snapshotPage(github(() => page([rawEvent(1)], 2)));
	await fixture.snapshotPage(github(() => page([rawEvent(2)])));
	for (let index = 0; index < 2; index++)
		await fixture.stream(
			github(() => {
				throw new Error("must reuse");
			}),
		);
	expect((await fixture.read())?.items.map((item) => item.id)).toEqual(["N_1", "N_2"]);
	expect(fixture.snapshot.requests).toBe(0);
});

it("does not refetch committed pages after request-budget interruption", async () => {
	const fixture = await setup();
	await fixture.stream(github(() => page([rawEvent(1)], 2)));
	const stopped = new InvocationStopped();
	await expect(
		fixture.stream(
			github(() => {
				throw stopped;
			}),
		),
	).rejects.toBe(stopped);
	await fixture.stream(
		github((url) => {
			expect(new URL(url).searchParams.get("page")).toBe("2");
			return page([rawEvent(2)]);
		}),
	);
	expect((await fixture.read())?.items.map((item) => item.id)).toEqual(["N_1", "N_2"]);
});

it("does not apply the filtered 1000-result search cap to a complete unfiltered source", async () => {
	const fixture = await setup();
	await fixture.stream(
		github(() =>
			page(
				Array.from({ length: 1000 }, (_, index) => rawEvent(index)),
				2,
				1100,
			),
		),
	);
	await fixture.stream(
		github(() =>
			page(
				Array.from({ length: 100 }, (_, index) => rawEvent(index + 1000)),
				undefined,
				1100,
			),
		),
	);
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "complete",
		observed: 1100,
		pages: 2,
	});
	expect(
		(
			await fixture.snapshotPage(
				github(() => {
					throw new Error("must reuse");
				}),
			)
		).done,
	).toBe(true);
});

it("retains incomplete history and uses bounded window splitting for the stream", async () => {
	const fixture = await setup();
	await fixture.stream(github(() => page([rawEvent(1)], undefined, 1500)));
	expect((await fixture.read())?.coverage.status).toBe("partial");
	await fixture.stream(
		github((url) => {
			expect(new URL(url).searchParams.has("created")).toBe(true);
			return page([], undefined, "2500+");
		}),
	);
	expect((await fixture.read())?.ranges).toHaveLength(1);
	await fixture.stream(github(() => page([rawEvent(1)])));
	await fixture.stream(github(() => page([rawEvent(1), rawEvent(2)])));
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "complete",
		observed: 2,
		pages: 3,
	});
	await expect(
		fixture.snapshotPage(
			github(() => {
				throw new Error("incomplete source must not refetch");
			}),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
});

it("preserves the unsplittable one-second Actions limit", async () => {
	const fixture = await setup();
	fixture.snapshot.window = {
		since: "2026-09-01T00:00:00.000Z",
		until: "2026-09-01T00:00:01.000Z",
	};
	await fixture.stream(github(() => page([], undefined, 5000)));
	await fixture.stream(github(() => page([], undefined, 1001)));
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "limited",
		reason: "More than 1,000 workflow runs in one second",
	});
});

it("propagates transient and authorization errors without persisting unsafe diagnostics", async () => {
	const fixture = await setup();
	const error = new ApiError(401, "github_unauthorized", "private-token");
	await expect(
		fixture.stream(
			github(() => {
				throw error;
			}),
		),
	).rejects.toBe(error);
	expect(await fixture.read()).toBeNull();
	await fixture.stream(github(() => Response.json({ message: "private-token" }, { status: 403 })));
	expect((await fixture.read())?.coverage.status).toBe("unavailable");
	const rows = await createDb(fixture.raw).prepare("SELECT payload FROM factory_resources").all();
	expect(JSON.stringify(rows)).not.toContain("private-token");
});

it("rejects credentials echoed in retained Actions fields", async () => {
	const fixture = await setup();
	await expect(
		fixture.stream(github(() => page([{ ...rawEvent(), name: "private-token" }]))),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
	expect(await fixture.read()).toBeNull();
});

it("keeps inclusive activity end-boundary runs without changing the frozen window", async () => {
	const fixture = await setup();
	fixture.snapshot.activityWindow = { ...fixture.snapshot.window, gap: false, first: false };
	const window = structuredClone(fixture.snapshot.window);
	await fixture.stream(github(() => page([{ ...rawEvent(), created_at: window.until }])));
	expect((await fixture.read())?.items).toHaveLength(1);
	expect(fixture.snapshot.window).toEqual(window);
	expect(streamKey("nocoo/app", "actions")).toBe("factory:nocoo/app:actions");
});

it("checkpoints a successful response before enforcing its newly observed rate reserve", async () => {
	const fixture = await setup();
	await fixture.stream(
		github(() =>
			Response.json(
				{ workflow_runs: [rawEvent(1)] },
				{ headers: { "x-ratelimit-remaining": "49" } },
			),
		),
	);
	expect((await fixture.read())?.coverage.status).toBe("complete");
	expect(fixture.snapshot.rate?.remaining).toBe(49);
});

it("keeps safe permission classification when sharing an unavailable source", async () => {
	const fixture = await setup();
	await fixture.stream(
		github(() =>
			Response.json(
				{ message: "Resource not accessible by personal access token" },
				{ status: 403 },
			),
		),
	);
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "unavailable",
		reason_code: "permission_denied",
	});
});

it("retains the filtered 100-page budget after an incomplete unfiltered source", async () => {
	const fixture = await setup();
	await fixture.stream(github(() => page([], undefined, 5000)));
	for (let index = 1; index <= 100; index++)
		await fixture.stream(github(() => page([rawEvent(index)], index + 1)));
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "limited",
		pages: 100,
		observed: 100,
		reason: "Workflow pagination exceeds 100-page budget; observed subset only",
	});
});

it("finishes a 40-page shared snapshot with a bounded number of database reads", async () => {
	const fixture = await setup();
	for (let index = 1; index <= 40; index++)
		await fixture.stream(github(() => page([rawEvent(index)], index < 40 ? index + 1 : undefined)));
	const db = createDb(fixture.raw);
	const result = await collectSitePage(
		db,
		fixture.lease,
		fixture.site,
		github(() => {
			throw new Error("must reuse");
		}),
		"private-token",
		NOW,
	);
	expect(result.done).toBe(true);
	expect(db.statements).toBeLessThan(10);
});

it.each([30, 90])(
	"matches native filtered-window events and metrics for a frozen %s-day run",
	async (days) => {
		const fixture = await setup();
		fixture.snapshot.window.since = new Date(Date.parse(NOW) - days * 86400_000).toISOString();
		const original = ready("actions");
		original.runId = fixture.snapshot.runId;
		original.window = structuredClone(fixture.snapshot.window);
		const saved = memoryStore();
		const runs = [
			{
				...rawEvent(1),
				created_at: original.window.since,
				conclusion: "failure",
				user: null,
				author: null,
				actor: { login: "actor" },
			},
			{ ...rawEvent(2), created_at: NOW, conclusion: "success" },
			{ ...rawEvent(3), created_at: "2020-01-01T00:00:00Z", conclusion: "success" },
			{ ...rawEvent(4), conclusion: "success", status: "completed" },
		];
		await fixture.stream(github(() => page(runs, undefined, 4)));
		await stepFactory(
			original,
			github((url) => {
				expect(new URL(url).searchParams.get("created")).toBe(`${original.window.since}..${NOW}`);
				return page(
					runs.filter((run) => Date.parse(run.created_at) >= Date.parse(original.window.since)),
				);
			}),
			"fake",
			saved,
			NOW,
		);
		expect((await fixture.read())?.items).toEqual(
			saved.data.get(streamKey("nocoo/app", "actions"))?.items,
		);
		expect(fixture.snapshot.repos[0]?.metrics).toEqual(original.repos[0]?.metrics);
	},
);

it.each([null, {}, [null], [[]], [42]])(
	"rejects malformed Actions source lists: %j",
	async (runs) => {
		const fixture = await setup();
		await fixture.stream(github(() => Response.json({ workflow_runs: runs })));
		expect((await fixture.read())?.coverage.status).toBe("limited");
		await expect(
			fixture.snapshotPage(
				github(() => {
					throw new Error("must not refetch malformed source");
				}),
			),
		).rejects.toMatchObject({ code: "snapshot_incomplete" });
	},
);

it("rejects foreign pagination without caching credentials or partial metadata", async () => {
	const fixture = await setup();
	await fixture.stream(
		github(() =>
			Response.json(
				{ workflow_runs: [] },
				{ headers: { link: '<https://evil.example/actions/runs?page=2>; rel="next"' } },
			),
		),
	);
	expect((await fixture.read())?.coverage.status).toBe("limited");
	await expect(
		fixture.snapshotPage(
			github(() => {
				throw new Error("must not refetch malformed source");
			}),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
});

it("keeps partial access loss and response-size failures limited instead of successful zero", async () => {
	for (const error of [
		new ApiError(403, "github_forbidden", "unsafe"),
		new ApiError(502, "github_response_too_large", "unsafe"),
	]) {
		const fixture = await setup();
		await fixture.stream(github(() => page([rawEvent()], 2)));
		await fixture.stream(
			github(() => {
				throw error;
			}),
		);
		expect((await fixture.read())?.coverage.status).toBe("limited");
		await expect(
			fixture.snapshotPage(
				github(() => {
					throw new Error("must not refetch");
				}),
			),
		).rejects.toMatchObject({ code: "snapshot_incomplete" });
	}
});

it("reuses unavailable evidence for snapshots without another network call", async () => {
	const fixture = await setup();
	await fixture.stream(github(() => Response.json({ message: "Not Found" }, { status: 404 })));
	await expect(
		fixture.snapshotPage(
			github(() => {
				throw new Error("must not refetch");
			}),
		),
	).rejects.toMatchObject({ code: "not_found" });
});

it("bounds shared bytes and keeps the window stream resumable when raw history is too large", async () => {
	const fixture = await setup();
	await fixture.stream(github(() => page([{ ...rawEvent(), name: "x".repeat(MAX_STAGED_BYTES) }])));
	expect((await fixture.read())?.coverage.status).toBe("partial");
	await fixture.stream(github(() => page([rawEvent()])));
	expect((await fixture.read())?.coverage.status).toBe("complete");
	await expect(
		fixture.snapshotPage(
			github(() => {
				throw new Error("must not refetch");
			}),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
});

it("switches to window collection at the 40-page history limit without re-fetching history", async () => {
	const fixture = await setup();
	for (let index = 1; index <= 40; index++)
		await fixture.stream(github(() => page([rawEvent(index)], index + 1)));
	expect((await fixture.read())?.coverage).toMatchObject({
		status: "partial",
		pages: 0,
		observed: 0,
	});
	await fixture.stream(
		github((url) => {
			expect(new URL(url).searchParams.has("created")).toBe(true);
			return page([rawEvent(1)]);
		}),
	);
	expect((await fixture.read())?.coverage.status).toBe("complete");
});

it("fails closed when a persisted source page disappears before replay or snapshot derivation", async () => {
	const fixture = await setup();
	await fixture.snapshotPage(github(() => page([rawEvent()])));
	await fixture.raw
		.prepare("DELETE FROM factory_resources WHERE stream LIKE 'actions-source:%'")
		.run();
	await expect(
		fixture.stream(
			github(() => {
				throw new Error("must not refetch");
			}),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
	await expect(
		fixture.snapshotPage(
			github(() => {
				throw new Error("must not refetch");
			}),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
});

it("rejects missing repo state and a terminal source with missing page metadata", async () => {
	const fixture = await setup();
	fixture.snapshot.cursor.repo = 1;
	await expect(
		fixture.stream(
			github(() => {
				throw new Error("must not fetch");
			}),
		),
	).rejects.toMatchObject({ code: "snapshot_missing" });
	fixture.snapshot.cursor.repo = 0;
	await fixture.raw
		.prepare(
			"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES('actions','nocoo/app','actions-source',?)",
		)
		.bind(
			JSON.stringify({
				status: "complete",
				next: null,
				pages: 0,
				observed: 0,
				expected: 0,
				bytes: 0,
			}),
		)
		.run();
	await expect(
		fixture.stream(
			github(() => {
				throw new Error("must not fetch");
			}),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
});

it("records fresh reset headers and does not replay stale rate observations", async () => {
	const fixture = await setup();
	await fixture.stream(
		github(() =>
			Response.json(
				{ workflow_runs: [] },
				{ headers: { "x-ratelimit-remaining": "99", "x-ratelimit-reset": "2000000000" } },
			),
		),
	);
	expect(fixture.snapshot.rate).toMatchObject({
		remaining: 99,
		resetAt: "2033-05-18T03:33:20.000Z",
	});
});

it("fences a completed source page when another invocation takes over before checkpoint", async () => {
	const fixture = await setup();
	const db = createDb(fixture.raw);
	const writes = await stepActions(
		db,
		fixture.lease,
		fixture.snapshot,
		github(() => page([rawEvent()], 2)),
		"fake",
		memoryStore(),
		NOW,
	);
	const later = new Date(Date.parse(NOW) + 120_000).toISOString();
	expect(await claimRun(createDb(fixture.raw), "actions", later)).not.toBeNull();
	expect(await saveRun(db, fixture.lease, writes, later, true)).toBe(false);
	expect(
		await fixture.raw.prepare("SELECT count(*) AS total FROM factory_resources").first(),
	).toEqual({ total: 0 });
});

it.each([false, true])(
	"answers deployment history from dense successful pages across sparse raw history, deploy=%s",
	async (hasDeploy) => {
		const fixture = await setup();
		for (let index = 1; index <= 25; index++)
			await fixture.stream(
				github(() =>
					page(
						[
							{
								...rawEvent(index),
								status: "completed",
								conclusion: index === 25 ? "success" : "failure",
								name: hasDeploy ? "Deploy" : "Test",
								updated_at: NOW,
							},
						],
						index < 25 ? index + 1 : undefined,
					),
				),
			);
		fixture.lease.run.activityWindow = { ...fixture.snapshot.window, gap: false, first: false };
		const upstream = github(() => {
			throw new Error("complete Actions history must not refetch");
		});
		const client = await cachedActionsClient(
			createDb(fixture.raw),
			fixture.lease,
			"nocoo/app",
			upstream,
		);
		const previous: ActivitySupplement = {
			commits: [],
			tags: [],
			last_success_at: null,
			coverage: {},
			phase: "deploy",
			after: null,
			tagAfter: null,
			pending: [],
			deployNext: null,
			pages: 1,
		};
		const repo = fixture.snapshot.repos[0];
		if (!repo) throw new Error("missing repo");
		const result = await collectActivitySupplement(
			fixture.lease.run,
			repo,
			client,
			"fake",
			previous,
		);
		expect(result.done).toBe(true);
		expect(result.state.coverage.deploy).toMatchObject({ status: "complete", truncated: false });
		expect(result.state.last_success_at).toBe(hasDeploy ? NOW : null);
		expect(result.state.pages).toBe(2);
		expect(client.count).toBe(0);
	},
);

it("repaginates a complete successful list and delegates unrelated REST and GraphQL unchanged", async () => {
	const fixture = await setup();
	const runs = Array.from({ length: 205 }, (_, index) => ({
		...rawEvent(index),
		conclusion: "success",
	}));
	await fixture.stream(github(() => page(runs)));
	const upstream = github(() => Response.json({ data: { ok: true } }));
	const client = await cachedActionsClient(
		createDb(fixture.raw),
		fixture.lease,
		"nocoo/app",
		upstream,
	);
	for (let index = 1; index <= 3; index++) {
		const response = await client.githubApi(
			"fake",
			`/repos/nocoo/app/actions/runs?status=success&per_page=100&page=${index}`,
		);
		const payload = (await response.json()) as { total_count: number; workflow_runs: unknown[] };
		expect(payload.total_count).toBe(205);
		expect(payload.workflow_runs).toHaveLength(index < 3 ? 100 : 5);
		expect(response.headers.get("link")?.includes(`page=${index + 1}`) ?? false).toBe(index < 3);
	}
	expect(client.count).toBe(0);
	await client.githubApi("fake", "/repos/nocoo/app/actions/runs?status=success&branch=main");
	await client.githubApi("fake", "/repos/nocoo/other/actions/runs?status=success");
	await client.githubApi("fake", "/repos/nocoo/app/actions/runs?status=success", {
		method: "POST",
	});
	await client.githubGraphql("fake", "query { ok }", {});
	expect(client.count).toBe(4);
	expect(client.graphqlErrors).toEqual(upstream.graphqlErrors);
});

it("never treats partial, unavailable, or filtered-only Actions history as a complete cache", async () => {
	for (const response of [
		() => page([rawEvent()], 2),
		() => page([], undefined, 5000),
		() => Response.json({ message: "Not Found" }, { status: 404 }),
	]) {
		const fixture = await setup();
		await fixture.stream(github(response));
		const upstream = github(() => page([]));
		expect(
			await cachedActionsClient(createDb(fixture.raw), fixture.lease, "nocoo/app", upstream),
		).toBe(upstream);
	}
});

it("preserves real transient upstream failures for retry and resumes from the last committed cursor", async () => {
	const fixture = await setup();
	await fixture.stream(github(() => page([rawEvent(1)], 2)));
	const transient = new ApiError(502, "github_error", "upstream temporarily failed");
	await expect(
		fixture.stream(
			github(() => {
				throw transient;
			}),
		),
	).rejects.toBe(transient);
	await fixture.stream(
		github((url) => {
			expect(new URL(url).searchParams.get("page")).toBe("2");
			return page([rawEvent(2)]);
		}),
	);
	expect((await fixture.read())?.coverage).toMatchObject({ status: "complete", observed: 2 });
});

it("remembers malformed later pages while retaining only the earlier observed subset", async () => {
	const fixture = await setup();
	await fixture.stream(github(() => page([rawEvent(1)], 2)));
	await fixture.stream(
		github(() =>
			Response.json({ workflow_runs: [] }, { headers: { link: '<not-a-url>; rel="next"' } }),
		),
	);
	expect((await fixture.read())?.coverage).toMatchObject({ status: "limited", observed: 1 });
	await expect(
		fixture.snapshotPage(
			github(() => {
				throw new Error("must not refetch");
			}),
		),
	).rejects.toMatchObject({ code: "snapshot_incomplete" });
});

it("proves no successful run across complete history and validates cached page parameters", async () => {
	const fixture = await setup();
	await fixture.stream(github(() => page([{ ...rawEvent(), conclusion: "failure" }])));
	const client = await cachedActionsClient(
		createDb(fixture.raw),
		fixture.lease,
		"nocoo/app",
		github(() => {
			throw new Error("must not fetch");
		}),
	);
	const response = await client.githubApi("fake", "/repos/nocoo/app/actions/runs?status=success");
	expect(await response.json()).toEqual({ total_count: 0, workflow_runs: [] });
	expect(response.headers.get("link")).toBeNull();
	for (const query of ["page=0", "page=1.1", "per_page=0", "per_page=101", "per_page=x"])
		await expect(
			client.githubApi("fake", `/repos/nocoo/app/actions/runs?status=success&${query}`),
		).rejects.toMatchObject({ code: "github_error" });
	expect(client.count).toBe(0);
});
