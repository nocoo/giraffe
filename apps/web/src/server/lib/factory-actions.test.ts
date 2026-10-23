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
import { cachedActionsClient, stepActions } from "./factory-actions";
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
