import { afterEach, expect, it, vi } from "vitest";
import { rawEvent } from "../../../../../tests/fixtures/factory";
import legacy from "../../../../../tests/fixtures/factory-actions-v022.json";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import type { FactorySnapshot, FactoryStreamData } from "../../lib/factory-types";
import type { Env } from "../env";
import { createDb } from "./db/d1";
import { getRun, publishedFactory, startRun } from "./db/factory-runs";
import { replaceSnapshotStmts } from "./db/snapshots";
import { executeRunPage } from "./factory-execute";
import { FactoryInvocation, InvocationStopped } from "./factory-invocation";
import { encryptToken, parseKeyBytes } from "./token-crypto";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it.each(legacy.cases)(
	"resumes the real v0.22 $name Actions checkpoint without losing pages",
	async (entry) => {
		expect(legacy.sourceRevision).toBe("12d461220d3213cfc28209cb57b0b5bc496fcb37");
		const snapshot = structuredClone(entry.snapshot) as FactorySnapshot;
		const accepted = entry.resources["factory:nocoo/app:actions"] as FactoryStreamData;
		const now = snapshot.fetched_at;
		const env = {
			DB: sqliteFixture(),
			ENVIRONMENT: "development",
			GITHUB_API_BASE: "http://fixture",
			TOKEN_ENCRYPTION_KEY_V1: "0".repeat(64),
		} as unknown as Env;
		const db = createDb(env.DB);
		await db
			.prepare(
				"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at,capabilities) VALUES(?,?,?,?,?,?,?)",
			)
			.bind(
				snapshot.account_id,
				"nocoo",
				await encryptToken("fake", parseKeyBytes("0".repeat(64))),
				"fake",
				now,
				now,
				JSON.stringify({ repo: true, notifications: true }),
			)
			.run();
		await db.batch(await replaceSnapshotStmts(db, snapshot.account_id, "factory", snapshot, now));
		await db.batch(
			await replaceSnapshotStmts(
				db,
				snapshot.account_id,
				"repos",
				{ repos: [{ name_with_owner: "nocoo/app" }] },
				now,
			),
		);
		const initial = makeRun(
			snapshot.runId,
			snapshot.account_id,
			snapshot.owner,
			"upgrade",
			"refresh",
			snapshot.repos,
			now,
			[],
			["nocoo/app"],
			{ scope: "selected", repos: ["nocoo/app"] },
		);
		initial.window = snapshot.window;
		initial.checkpoint = snapshot;
		initial.requests = snapshot.requests;
		initial.cursor = initial.steps.findIndex((step) => step.kind === "actions");
		for (const step of initial.steps.slice(0, initial.cursor + 1)) {
			step.status = step.kind === "actions" ? "running" : "success";
			step.attempts = 1;
			step.startedAt = now;
			if (step.kind !== "actions") step.finishedAt = now;
		}
		await startRun(db, initial);
		for (const [key, data] of Object.entries(entry.resources))
			await db
				.prepare("INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,?,?,?)")
				.bind(initial.id, "nocoo/app", key.split(":").at(-1), JSON.stringify(data))
				.run();
		const read = async () => {
			const row = await createDb(env.DB)
				.prepare("SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=?")
				.bind(initial.id, "nocoo/app", "actions")
				.first<{ payload: string }>();
			if (!row) throw new Error("missing Actions checkpoint");
			return JSON.parse(row.payload) as FactoryStreamData;
		};
		const paths: string[] = [];
		if (!accepted.next) throw new Error("missing legacy cursor");
		const thirdPage = new URL(accepted.next, "https://api.github.com");
		thirdPage.searchParams.set("page", "3");
		const expectedPaths = [
			accepted.next,
			`${thirdPage.pathname}${thirdPage.search}`,
			...accepted.ranges.map(
				(range) =>
					`/repos/nocoo/app/actions/runs?created=${range.since}..${range.until}&per_page=100&page=1`,
			),
		];
		const filteredPaths: string[] = [];
		const runs = [{ ...rawEvent(101), created_at: accepted.items[0]?.at ?? now }];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const url = new URL(input);
				paths.push(`${url.pathname}${url.search}`);
				if (url.pathname.endsWith("/actions/runs")) {
					const current = Number(url.searchParams.get("page") ?? 1);
					const filtered = url.searchParams.has("created");
					const next = filtered ? (current === 2 ? 3 : null) : current === 1 ? 2 : null;
					if (filtered) {
						const path = `${url.pathname}${url.search}`;
						expect(path).toBe(expectedPaths[filteredPaths.length]);
						filteredPaths.push(path);
						const [since, until] = String(url.searchParams.get("created")).split("..");
						if (!since || !until) throw new Error("missing filtered range");
						const createdAt = Date.parse(since) + current * 60_000;
						expect(createdAt).toBeLessThan(Date.parse(until));
						runs.push({
							...rawEvent(101 + filteredPaths.length),
							created_at: new Date(createdAt).toISOString(),
						});
					}
					url.host = "api.github.com";
					url.protocol = "https:";
					if (next) url.searchParams.set("page", String(next));
					return Response.json(
						{
							total_count: filtered ? (current === 1 ? 1 : 3) : runs.length,
							workflow_runs: filtered
								? runs.slice(-1)
								: current === 1
									? runs.slice(0, 1)
									: runs.slice(1),
						},
						{ headers: next ? { link: `<${url}>; rel="next"` } : {} },
					);
				}
				const query = String(init?.body);
				if (query.includes("object(expression")) return Response.json({ data: { repository: {} } });
				if (query.includes("vulnerabilityAlerts"))
					return Response.json({
						data: {
							repository: { vulnerabilityAlerts: { nodes: [], pageInfo: { hasNextPage: false } } },
						},
					});
				if (query.includes("search(query"))
					return Response.json({
						data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
					});
				return Response.json([]);
			}),
		);
		const beforeRequest = FactoryInvocation.prototype.beforeRequest;
		vi.spyOn(FactoryInvocation.prototype, "beforeRequest").mockImplementation(function (
			this: FactoryInvocation,
			...args
		) {
			if (this.requests >= 1) throw new InvocationStopped();
			return beforeRequest.apply(this, args);
		});
		await executeRunPage(env, initial.id, () => now);
		const checkpoint = await read();
		expect(paths).toEqual([accepted.next]);
		expect(checkpoint.next).toContain("page=3");
		expect(checkpoint.coverage.pages).toBe(accepted.coverage.pages + 1);
		expect(checkpoint.coverage.source).toBe(accepted.coverage.source);
		expect(checkpoint.ranges).toEqual(accepted.ranges);
		expect(checkpoint.items[0]).toEqual(accepted.items[0]);
		vi.restoreAllMocks();
		let run = (await getRun(createDb(env.DB), initial.account_id, initial.id))?.run;
		for (let invocation = 0; run?.status === "running" && invocation < 40; invocation++) {
			const clock = run.nextAttemptAt;
			await executeRunPage(env, run.id, () => clock);
			run = (await getRun(createDb(env.DB), initial.account_id, initial.id))?.run;
		}
		expect(run?.steps.filter((step) => step.status !== "success")).toEqual([]);
		expect(run?.status).toBe("completed");
		expect(run?.publishedAt).toBeTruthy();
		expect(run?.steps.find((step) => step.kind === "actions")).toMatchObject({
			status: "success",
			attempts: 1,
			retryFailures: 0,
			error: null,
		});
		expect(run?.steps.find((step) => step.kind === "releases")).toMatchObject({
			status: "success",
			error: null,
		});
		const completed = await read();
		expect(completed.items[0]).toEqual(accepted.items[0]);
		expect(completed.items.map((item) => item.id)).toEqual(
			entry.name === "split-window"
				? ["N_101", "N_102", "N_103", "N_104"]
				: ["N_101", "N_102", "N_103"],
		);
		expect(completed.ranges).toEqual([]);
		expect(filteredPaths).toEqual(expectedPaths);
		expect(run?.requests).toBe(initial.requests + paths.length);
		expect(
			(await publishedFactory(createDb(env.DB), initial.account_id))?.repos[0]?.coverage.actions,
		).toMatchObject({ status: "complete", observed: completed.items.length });
	},
);
