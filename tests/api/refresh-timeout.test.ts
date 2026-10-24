import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { makeRun } from "../../apps/web/src/lib/factory-run";
import { executeD1FixtureSync } from "../fixtures/d1";
import { missedSlotFixture } from "../fixtures/missed-slots";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const root = resolve(import.meta.dirname, "../..");
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function rows(sql: string): Record<string, unknown>[] {
	const persist = process.env.GIRAFFE_PERSIST;
	const config = process.env.GIRAFFE_CONFIG;
	if (
		new URL(base).hostname !== "127.0.0.1" ||
		persist !== join(root, ".wrangler/e2e") ||
		config !== join(root, ".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 context required");
	const result = executeD1FixtureSync(sql, { persist, config, root });
	return (JSON.parse(result) as { results: Record<string, unknown>[] }[]).flatMap(
		(entry) => entry.results,
	);
}

async function fixture() {
	expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
	const account = randomUUID().replaceAll("-", "").slice(0, 21);
	const bearer = `giraffe_${createHash("sha256").update(account).digest("base64url")}`;
	const token = randomUUID().replaceAll("-", "").slice(0, 21);
	const now = new Date().toISOString();
	const expiry = new Date(Date.now() + 86400_000).toISOString();
	rows(`INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES(${literal(account)},${literal(`timeout-${account}`)},'test-not-an-encrypted-pat','fake',${literal(now)},${literal(now)});
INSERT INTO api_tokens(id,account_id,token_hash,label,scopes,creator,created_at,expires_at) VALUES(${literal(token)},${literal(account)},${literal(createHash("sha256").update(bearer).digest("hex"))},'timeout L2','["app:read","app:write"]','local test',${literal(now)},${literal(expiry)});`);
	const api = (path: string, method = "GET", body?: unknown) =>
		fetch(`${base}/api/v1/accounts/${account}/${path}`, {
			method,
			headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return {
		account,
		api,
		cleanup: () => {
			expect(rows("SELECT value FROM _test_marker WHERE key='env'")).toEqual([{ value: "test" }]);
			rows(`DELETE FROM accounts WHERE id=${literal(account)}`);
		},
	};
}

it.each([
	["catalog", "quick", "catalog", "running"],
	["refresh", "quick", "daily", "paused"],
	["refresh", "deep", "weekly", "running"],
] as const)(
	"reclaims stale %s/%s over HTTP without GET writes or duplicate account runs",
	async (mode, depth, kind, status) => {
		const s = await fixture();
		try {
			const started = new Date(Date.now() - 2 * 86400_000).toISOString();
			const run = makeRun(
				`stale-${randomUUID()}`,
				s.account,
				`timeout-${s.account}`,
				randomUUID(),
				mode,
				[],
				started,
			);
			Object.assign(run, { depth, status, schedule: { kind, dueAt: started } });
			const table = kind === "catalog" ? "catalog_refresh_schedules" : "refresh_schedules";
			rows(`INSERT INTO factory_runs(id,account_id,request_key,status,payload,lease_token,lease_until,next_at,created_at,updated_at) VALUES(${literal(run.id)},${literal(s.account)},${literal(run.requestKey)},${literal(status)},${literal(JSON.stringify(run))},'old-lease',${literal(new Date(Date.now() + 3600_000).toISOString())},${literal(started)},${literal(started)},${literal(started)});
INSERT INTO ${table}(account_id,kind,enabled,time,weekday,scope,next_at,last_run_id) VALUES(${literal(s.account)},${literal(kind)},1,'08:00',0,'all',${literal(new Date(Date.now() + 86400_000).toISOString())},${literal(run.id)});`);
			const before = rows(
				`SELECT payload,version,lease_token,lease_until FROM factory_runs WHERE id=${literal(run.id)}`,
			);
			const read = await s.api("refresh-runs");
			expect(read.status).toBe(200);
			expect(await read.json()).toMatchObject({
				items: [
					{
						id: run.id,
						status,
						expectedFinishAt: null,
						expectedFinishAtReason: "no_completed_history",
					},
				],
			});
			expect(
				rows(
					`SELECT payload,version,lease_token,lease_until FROM factory_runs WHERE id=${literal(run.id)}`,
				),
			).toEqual(before);
			const duplicate = await s.api("refresh-runs", "POST", {
				requestKey: run.requestKey,
				mode,
				depth,
				scope: "all",
			});
			expect(duplicate.status).toBe(202);
			expect(await duplicate.json()).toMatchObject({ id: run.id, status: "failed" });
			const history = await (await s.api("refresh-runs")).json();
			expect(history).toMatchObject({
				items: [
					{ id: run.id, status: "failed", error: "run_timed_out", deadlineAt: expect.any(String) },
				],
			});
			expect(JSON.stringify(history)).not.toContain("test-not-an-encrypted-pat");
			const settings = await (await s.api("settings")).json();
			expect(
				settings.schedules.find((entry: { kind: string }) => entry.kind === kind)?.lastError,
			).toBe("run_timed_out");
			expect(
				rows(`SELECT lease_token,lease_until FROM factory_runs WHERE id=${literal(run.id)}`),
			).toEqual([{ lease_token: null, lease_until: null }]);
			const competing = await Promise.all(
				[randomUUID(), randomUUID()].map((requestKey) =>
					s.api("refresh-runs", "POST", { requestKey, mode: "catalog", scope: "all" }),
				),
			);
			expect(competing.map((response) => response.status).sort()).toEqual([202, 409]);
			const conflict = competing.find((response) => response.status === 409);
			expect(await conflict?.json()).toMatchObject({ error: { code: "account_conflict" } });
			expect(
				rows(
					`SELECT id FROM factory_runs WHERE account_id=${literal(s.account)} AND status IN ('running','paused')`,
				),
			).toHaveLength(1);
			expect(
				await (await s.api(`refresh-runs/${run.id}/control`, "POST", { action: "resume" })).json(),
			).toMatchObject({ id: run.id, status: "failed" });
		} finally {
			s.cleanup();
		}
	},
);

it("publishes all missed slots durably and immutably through the local scheduled HTTP handler", async () => {
	const s = await fixture();
	try {
		const { today, due, time } = missedSlotFixture(new Date().toISOString());
		rows(
			`INSERT INTO catalog_refresh_schedules(account_id,kind,enabled,time,weekday,scope,next_at) VALUES(${literal(s.account)},'catalog',1,${literal(time)},0,'all',${literal(due)})`,
		);
		const cron = () =>
			fetch(`${base}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("* * * * *")}`);
		expect((await cron()).status).toBe(200);
		const read = await s.api("refresh-runs");
		expect(read.status).toBe(200);
		const history = await read.json();
		const missed = history.items.filter(
			(run: { error?: string }) => run.error === "scheduled_slot_missed",
		);
		expect(missed).toHaveLength(3);
		for (let daysAgo = 1; daysAgo <= 3; daysAgo++) {
			const dueAt = new Date(Date.parse(today) - daysAgo * 86400_000).toISOString();
			expect(
				missed.find((run: { requestKey: string }) => run.requestKey === `catalog:${dueAt}`),
			).toMatchObject({
				status: "failed",
				missedSlots: { firstDueAt: dueAt, lastDueAt: dueAt, count: 1 },
				expectedFinishAt: null,
				expectedFinishAtReason: "terminal",
			});
		}
		expect(
			history.items.filter((run: { requestKey: string }) => run.requestKey === `catalog:${today}`),
		).toHaveLength(1);
		const immutable = rows(
			`SELECT id,payload FROM factory_runs WHERE account_id=${literal(s.account)} AND json_extract(payload,'$.error')='scheduled_slot_missed' ORDER BY id`,
		);
		expect((await cron()).status).toBe(200);
		expect(
			rows(
				`SELECT id,payload FROM factory_runs WHERE account_id=${literal(s.account)} AND json_extract(payload,'$.error')='scheduled_slot_missed' ORDER BY id`,
			),
		).toEqual(immutable);
		const settings = await (await s.api("settings")).json();
		expect(
			settings.schedules.find((entry: { kind: string }) => entry.kind === "catalog")?.lastError,
		).toBe("scheduled_slot_missed");
	} finally {
		s.cleanup();
	}
});
