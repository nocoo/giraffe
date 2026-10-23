import { afterEach, expect, it, vi } from "vitest";
import { NOW, rawEvent, ready } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import type { FactoryStreamData } from "../../lib/factory-types";
import type { Env } from "../env";
import { createDb } from "./db/d1";
import { getRun, startRun } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { executeRunPage } from "./factory-execute";
import { FactoryInvocation, InvocationStopped } from "./factory-invocation";
import { mapFactoryEvents } from "./factory-map";
import { mapActionRuns } from "./github-map";
import { encryptToken, parseKeyBytes } from "./token-crypto";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function action(id: number, createdAt = "2020-01-01T00:00:00Z") {
	return {
		...rawEvent(id),
		name: "Deploy",
		status: "completed",
		conclusion: "success",
		created_at: createdAt,
		run_started_at: createdAt,
		updated_at: createdAt,
	};
}

it.each([false, true])(
	"keeps probe and intermediate delta work resumable through the executor, reconcile=%s",
	async (reconcile) => {
		const snapshot = ready("actions");
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
				NOW,
				NOW,
				JSON.stringify({ repo: true, notifications: true }),
			)
			.run();
		const previous = "previous-actions";
		const observedAt = "2026-09-14T22:00:00.000Z";
		const history = Array.from({ length: 350 }, (_, index) => action(index + 1));
		const recent = action(351, "2026-09-01T00:00:00Z");
		const baseline = [recent, ...history];
		await db
			.prepare(
				"INSERT INTO factory_runs(id,account_id,request_key,status,payload,next_at,created_at,updated_at) VALUES(?,?,'previous','completed','{}',?,?,?)",
			)
			.bind(previous, snapshot.account_id, observedAt, observedAt, observedAt)
			.run();
		await db
			.prepare(
				"INSERT INTO factory_repo_versions(account_id,repo,version,payload,refreshed_at) VALUES(?,'nocoo/app',?,?,?)",
			)
			.bind(snapshot.account_id, previous, JSON.stringify(snapshot.repos[0]), observedAt)
			.run();
		await db
			.prepare(
				"INSERT INTO factory_repo_state(account_id,repo,version,payload) VALUES(?,'nocoo/app',?,'{}')",
			)
			.bind(snapshot.account_id, previous)
			.run();
		const resources: [string, unknown][] = [
			[
				"actions-source",
				{
					status: "complete",
					next: null,
					pages: 4,
					observed: baseline.length,
					expected: baseline.length,
					bytes: 0,
				},
			],
		];
		for (let index = 0; index < 4; index++)
			resources.push([
				`actions-source:${String(index).padStart(3, "0")}:000`,
				JSON.stringify({ runs: baseline.slice(index * 100, (index + 1) * 100), next: null }),
			]);
		for (const [key, value] of resources)
			await db
				.prepare(
					"INSERT INTO factory_resources(run_id,repo,stream,payload) VALUES(?,'nocoo/app',?,?)",
				)
				.bind(previous, key, JSON.stringify(value))
				.run();
		const run = makeRun(
			"executor-actions",
			snapshot.account_id,
			"nocoo",
			"incremental",
			"refresh",
			snapshot.repos,
			NOW,
			[],
			["nocoo/app"],
			{ scope: "selected", repos: ["nocoo/app"] },
		);
		run.steps = run.steps.filter(
			(step) => step.kind === "actions" || step.resource === "repo:nocoo/app:actions",
		);
		snapshot.runId = run.id;
		run.checkpoint = snapshot;
		await startRun(db, run);
		const delta = [
			action(353, "2026-09-15T21:00:00Z"),
			action(352, "2026-09-15T20:00:00Z"),
			recent,
		];
		const all = [...delta, ...history];
		const paths: string[] = [];
		let probed = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				const url = new URL(input);
				paths.push(`${url.pathname}${url.search}`);
				expect(url.pathname).toBe("/repos/nocoo/app/actions/runs");
				const filtered = url.searchParams.has("created");
				const index = Number(url.searchParams.get("page") ?? 1);
				let runs: unknown[];
				let total: number;
				let next: number | null;
				if (filtered) {
					runs = reconcile ? [] : delta.slice((index - 1) * 2, index * 2);
					total = reconcile ? 1001 : delta.length;
					next = !reconcile && index === 1 ? 2 : null;
				} else {
					if (probed) expect(reconcile).toBe(true);
					probed = true;
					runs = all.slice((index - 1) * 100, index * 100);
					total = all.length;
					next = index < Math.ceil(all.length / 100) ? index + 1 : null;
				}
				url.host = "api.github.com";
				url.protocol = "https:";
				if (next) url.searchParams.set("page", String(next));
				return Response.json(
					{ workflow_runs: runs, total_count: total },
					{
						headers: next ? { link: `<${url}>; rel="next"` } : {},
					},
				);
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
		for (let invocation = 0; invocation < 2; invocation++) {
			await executeRunPage(env, run.id, () => NOW);
			const saved = (await getRun(createDb(env.DB), run.account_id, run.id))?.run;
			const step = saved?.steps.find((current) => current.kind === "actions");
			expect(["pending", "running"]).toContain(step?.status);
			expect(step).toMatchObject({ error: null, finishedAt: null, attempts: 1 });
			expect(saved?.checkpoint?.repos[0]?.coverage.actions.status).toBe("partial");
		}
		let completed = (await getRun(createDb(env.DB), run.account_id, run.id))?.run;
		for (let invocation = 0; completed?.status === "running" && invocation < 10; invocation++) {
			const clock = completed.nextAttemptAt;
			await executeRunPage(env, run.id, () => clock);
			completed = (await getRun(createDb(env.DB), run.account_id, run.id))?.run;
		}
		expect(completed?.status).toBe("completed");
		expect(completed?.steps.every((step) => step.status === "success")).toBe(true);
		expect(completed?.steps.find((step) => step.kind === "actions")).toMatchObject({
			strategy: reconcile ? "full" : "incremental",
			error: null,
			attempts: 1,
		});
		const stream = await createDb(env.DB)
			.prepare(
				"SELECT payload FROM factory_resources WHERE run_id=? AND repo='nocoo/app' AND stream='actions'",
			)
			.bind(run.id)
			.first<{ payload: string }>();
		const data = JSON.parse(stream?.payload ?? "null") as FactoryStreamData;
		expect(data.coverage.status).toBe("complete");
		expect(data.items).toEqual(mapFactoryEvents("actions", delta));
		expect(
			await readSnapshot(createDb(env.DB), run.account_id, "repo:nocoo/app:actions", run.id),
		).toMatchObject({ truncated: false, runs: mapActionRuns({ workflow_runs: all }) });
		expect(paths).toHaveLength(reconcile ? 6 : 3);
		expect(completed?.requests).toBe(paths.length);
	},
);
