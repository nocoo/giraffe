import { expect, it } from "vitest";
import { github, NOW } from "../../../../../tests/fixtures/factory";
import { sqliteFixture } from "../../../../../tests/fixtures/sqlite";
import { makeRun } from "../../lib/factory-run";
import { MAX_STAGED_BYTES } from "./collect";
import { createDb } from "./db/d1";
import { claimRun, saveRun, startRun } from "./db/factory-runs";
import { ApiError } from "./errors";
import { SnapshotPageReady, snapshotReplay } from "./factory-snapshot-replay";
import { GithubUnavailableError } from "./github-unavailable";

async function setup() {
	const raw = sqliteFixture();
	const db = createDb(raw);
	await db
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,created_at,updated_at) VALUES('account','nocoo','encrypted','fake',?,?)",
		)
		.bind(NOW, NOW)
		.run();
	await startRun(db, makeRun("site", "account", "nocoo", "request", "refresh", [], NOW));
	const lease = await claimRun(db, "site", NOW);
	if (!lease) throw new Error("fixture lease missing");
	return { raw, db, lease };
}

it("replays REST bodies and Link only without persisting credentials or response diagnostics", async () => {
	const { db, lease } = await setup();
	const link = '<https://api.github.com/notifications?page=2>; rel="next"';
	const replay = await snapshotReplay(
		db,
		lease,
		"notifications",
		0,
		github(() =>
			Response.json([{ id: 1 }], {
				headers: {
					link,
					authorization: "Bearer private-token",
					"x-private-diagnostic": "private-diagnostic",
				},
			}),
		),
		NOW,
	);
	expect(await (await replay.client.githubApi("private-token", "/notifications")).json()).toEqual([
		{ id: 1 },
	]);
	await expect(
		replay.client.githubApi("private-token", "/notifications?page=2"),
	).rejects.toBeInstanceOf(SnapshotPageReady);
	expect(await saveRun(db, lease, replay.writes, NOW, true)).toBe(true);
	const rows = await db.prepare("SELECT payload FROM factory_resources").all();
	expect(JSON.stringify(rows)).not.toContain("private-token");
	expect(JSON.stringify(rows)).not.toContain("private-diagnostic");
	const resumed = await snapshotReplay(
		db,
		lease,
		"notifications",
		0,
		github(() => {
			throw new Error("no network");
		}),
		NOW,
	);
	const response = await resumed.client.githubApi("rotated-token", "/notifications");
	expect(response.headers.get("link")).toBe(link);
	expect(await response.json()).toEqual([{ id: 1 }]);
	expect(resumed.client.count).toBe(1);
	expect(resumed.writes).toEqual([]);
});

it("never persists an echoed token in successful response bodies or Link cursors", async () => {
	for (const response of [
		Response.json({ value: "private-token" }),
		Response.json([], {
			headers: { link: '<https://api.github.com/x?token=private-token>; rel="next"' },
		}),
	]) {
		const { db, lease } = await setup();
		const replay = await snapshotReplay(
			db,
			lease,
			"notifications",
			0,
			github(() => response),
			NOW,
		);
		await expect(replay.client.githubApi("private-token", "/notifications")).rejects.toMatchObject({
			code: "snapshot_incomplete",
		});
		expect(replay.writes).toEqual([]);
	}
});

it("rejects a changed request identity and read-write or raw-fetch API bypasses", async () => {
	const { db, lease } = await setup();
	const replay = await snapshotReplay(
		db,
		lease,
		"notifications",
		0,
		github(() => Response.json([])),
		NOW,
	);
	await replay.client.githubApi("fake", "/notifications");
	expect(await saveRun(db, lease, replay.writes, NOW, true)).toBe(true);
	const resumed = await snapshotReplay(
		db,
		lease,
		"notifications",
		0,
		github(() => {
			throw new Error("no network");
		}),
		NOW,
	);
	await expect(resumed.client.githubApi("fake", "/other")).rejects.toMatchObject({
		code: "snapshot_incomplete",
	});
	await expect(
		resumed.client.githubApi("fake", "/notifications", { method: "PUT" }),
	).rejects.toMatchObject({ code: "internal_error" });
	await expect(
		resumed.client.githubFetch("https://api.github.com/notifications"),
	).rejects.toMatchObject({ code: "internal_error" });
});

it("preserves sanitized soft-error classifications across a request boundary", async () => {
	for (const error of [
		new GithubUnavailableError(403, "Dependabot alerts are disabled"),
		new GithubUnavailableError(404, "Not Found"),
		new GithubUnavailableError(404, "SAML access restricted", true),
		new ApiError(403, "github_forbidden", "private upstream message"),
	]) {
		const { db, lease } = await setup();
		const replay = await snapshotReplay(
			db,
			lease,
			"alerts",
			0,
			github(() => {
				throw error;
			}),
			NOW,
		);
		await expect(replay.client.githubApi("fake", "/alerts")).rejects.toMatchObject({
			code: error.code,
		});
		expect(await saveRun(db, lease, replay.writes, NOW, true)).toBe(true);
		const resumed = await snapshotReplay(
			db,
			lease,
			"alerts",
			0,
			github(() => {
				throw new Error("no network");
			}),
			NOW,
		);
		await expect(resumed.client.githubApi("fake", "/alerts")).rejects.toMatchObject({
			status: error.status,
			code: error.code,
			...(error instanceof GithubUnavailableError
				? { reasonCode: error.reasonCode, unambiguousNotFound: error.unambiguousNotFound }
				: {}),
		});
		expect(
			JSON.stringify(await db.prepare("SELECT payload FROM factory_resources").all()),
		).not.toContain("private upstream message");
	}
});

it("does not cache retryable, unauthorized, or unknown failures", async () => {
	for (const error of [
		new ApiError(401, "github_unauthorized", "unauthorized"),
		new ApiError(503, "github_rate_limited", "limited", NOW),
		new Error("network"),
	]) {
		const { db, lease } = await setup();
		const client = github(() => Response.json([]));
		client.githubApi = async () => {
			throw error;
		};
		const replay = await snapshotReplay(db, lease, "notifications", 0, client, NOW);
		await expect(replay.client.githubApi("fake", "/notifications")).rejects.toBe(error);
		expect(replay.writes).toEqual([]);
	}
});

it("replays GraphQL data with its sanitized errors and isolates consumer mutations", async () => {
	const { db, lease } = await setup();
	const client = github(() =>
		Response.json({
			data: { repository: null },
			errors: [{ type: "FORBIDDEN", message: "private SAML error", path: ["repository"] }],
		}),
	);
	const replay = await snapshotReplay(db, lease, "alerts", 0, client, NOW);
	await replay.client.githubGraphql("fake", "query", { owner: "nocoo" });
	expect(await saveRun(db, lease, replay.writes, NOW, true)).toBe(true);
	const resumed = await snapshotReplay(
		db,
		lease,
		"alerts",
		0,
		github(() => {
			throw new Error("no network");
		}),
		NOW,
	);
	expect(await resumed.client.githubGraphql("fake", "query", { owner: "nocoo" })).toEqual({
		repository: null,
	});
	expect(resumed.client.graphqlErrors).toEqual(replay.client.graphqlErrors);
	expect(resumed.client.graphqlErrors[0]?.reasonCode).toBe("permission_denied");
	expect(
		JSON.stringify(await db.prepare("SELECT payload FROM factory_resources").all()),
	).not.toContain("private SAML error");
});

it("supports bodyless responses and fences stale writes", async () => {
	const { db, lease } = await setup();
	const replay = await snapshotReplay(
		db,
		lease,
		"notifications",
		0,
		github(() => new Response(null, { status: 204 })),
		NOW,
	);
	expect((await replay.client.githubApi("fake", "/notifications")).status).toBe(204);
	await db.prepare("UPDATE factory_runs SET lease_token='replacement' WHERE id='site'").run();
	await db.batch(replay.writes);
	expect(await db.prepare("SELECT count(*) AS total FROM factory_resources").first()).toEqual({
		total: 0,
	});
});

it("chunks large UTF-8 responses below the D1 row cap and reconstructs every byte", async () => {
	const { db, lease } = await setup();
	const text = '界🦒\\"'.repeat(110_000);
	const replay = await snapshotReplay(
		db,
		lease,
		"notifications",
		0,
		github(() => Response.json([{ text }])),
		NOW,
	);
	await replay.client.githubApi("fake", "/notifications");
	expect(replay.writes.length).toBeGreaterThan(1);
	expect(await saveRun(db, lease, replay.writes, NOW, true)).toBe(true);
	const rows = await db.prepare("SELECT payload FROM factory_resources").all<{ payload: string }>();
	for (const row of rows.results)
		expect(new TextEncoder().encode(row.payload).length).toBeLessThan(1_800_000);
	const resumed = await snapshotReplay(
		db,
		lease,
		"notifications",
		0,
		github(() => {
			throw new Error("no network");
		}),
		NOW,
	);
	expect(await (await resumed.client.githubApi("fake", "/notifications")).json()).toEqual([
		{ text },
	]);
	expect(await saveRun(db, lease, resumed.cleanup(), NOW, true)).toBe(true);
	expect(await db.prepare("SELECT count(*) AS total FROM factory_resources").first()).toEqual({
		total: 0,
	});
});

it("rejects an oversized replay instead of silently dropping accumulated evidence", async () => {
	const { db, lease } = await setup();
	const replay = await snapshotReplay(
		db,
		lease,
		"notifications",
		0,
		github(() => Response.json([{ text: "x".repeat(MAX_STAGED_BYTES) }])),
		NOW,
	);
	await replay.client.githubApi("fake", "/notifications");
	expect(() => replay.writes).toThrowError(
		expect.objectContaining({ code: "snapshot_incomplete" }),
	);
	expect(await db.prepare("SELECT count(*) AS total FROM factory_resources").first()).toEqual({
		total: 0,
	});
});
