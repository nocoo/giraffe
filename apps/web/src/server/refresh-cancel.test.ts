import { expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../tests/fixtures/sqlite";
import { createDb } from "./lib/db/d1";
import { parseRefreshParams } from "./lib/refresh-params";
import {
	activeRefreshRun,
	cancelRefreshRun,
	createRefreshRun,
	getRefreshRun,
	saveRefreshRun,
} from "./lib/refresh-store";
import { requestCancellation } from "./refresh-cancel";

const now = "2026-10-29T01:00:00.000Z";

async function fixture() {
	const raw = sqliteFixture();
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','octo','fake','fake','t','t'),('other','other','fake','fake','t','t')",
		)
		.run();
	const db = createDb(raw);
	const created = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		now,
	);
	const running = { ...created, status: "running" as const };
	await saveRefreshRun(db, running);
	return { db, running };
}

function registrar() {
	const registered: Promise<unknown>[] = [];
	return {
		registered,
		waitUntil: (work: Promise<unknown>) => {
			registered.push(work);
		},
	};
}

it("returns the persisted cancellation without waiting for the runner", async () => {
	const { db, running } = await fixture();
	const { registered, waitUntil } = registrar();
	const run = await requestCancellation({
		db,
		accountId: "account",
		id: running.id,
		at: "2026-10-29T01:01:00.000Z",
		wake: () => new Promise<void>(() => {}),
		waitUntil,
	});
	expect(run).toMatchObject({
		status: "running",
		cancelRequested: true,
		updatedAt: "2026-10-29T01:01:00.000Z",
	});
	expect(registered).toHaveLength(1);
});

it("never rejects a registered wake that throws or fails asynchronously", async () => {
	const { db, running } = await fixture();
	const seen: (boolean | undefined)[] = [];
	const failed = registrar();
	expect(
		await requestCancellation({
			db,
			accountId: "account",
			id: running.id,
			at: now,
			wake: async () => {
				seen.push((await getRefreshRun(db, "account", running.id))?.cancelRequested);
				throw new Error("Durable Object exceeded its CPU time limit and was reset.");
			},
			waitUntil: failed.waitUntil,
		}),
	).toMatchObject({ status: "running", cancelRequested: true });
	await expect(failed.registered[0]).resolves.toBeUndefined();
	expect(seen).toEqual([true]);
	const rejected = registrar();
	await requestCancellation({
		db,
		accountId: "account",
		id: running.id,
		at: now,
		wake: () => Promise.reject(new Error("network down")),
		waitUntil: rejected.waitUntil,
	});
	await expect(rejected.registered[0]).resolves.toBeUndefined();
	expect(await getRefreshRun(db, "account", running.id)).toMatchObject({
		status: "running",
		cancelRequested: true,
	});
});

it("cancels a queued run in D1 and still wakes the runner for the next run", async () => {
	const { db, running } = await fixture();
	const queued = await createRefreshRun(
		db,
		"account",
		parseRefreshParams({}, new Date(now)),
		"manual",
		"2026-10-29T01:00:01.000Z",
	);
	const { registered, waitUntil } = registrar();
	const run = await requestCancellation({
		db,
		accountId: "account",
		id: queued.id,
		at: "2026-10-29T01:01:00.000Z",
		wake: async () => {},
		waitUntil,
	});
	expect(run).toMatchObject({
		status: "cancelled",
		phase: "done",
		cancelRequested: true,
		updatedAt: "2026-10-29T01:01:00.000Z",
		finishedAt: "2026-10-29T01:01:00.000Z",
	});
	expect(await activeRefreshRun(db, "account")).toMatchObject({ id: running.id });
	expect(registered).toHaveLength(1);
});

it("does not wake the runner for missing, fenced or terminal runs", async () => {
	const { db, running } = await fixture();
	const wake = vi.fn(async () => {});
	const { registered, waitUntil } = registrar();
	const options = { db, at: now, wake, waitUntil };
	expect(await requestCancellation({ ...options, accountId: "account", id: "missing" })).toBeNull();
	expect(await requestCancellation({ ...options, accountId: "other", id: "missing" })).toBeNull();
	const terminal = cancelRefreshRun(running, "2026-10-29T01:01:00.000Z");
	await saveRefreshRun(db, terminal);
	expect(await requestCancellation({ ...options, accountId: "account", id: running.id })).toEqual(
		terminal,
	);
	expect(wake).not.toHaveBeenCalled();
	expect(registered).toHaveLength(0);
});
