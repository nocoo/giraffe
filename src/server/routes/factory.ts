import type { Context } from "hono";
import { z } from "zod";
import {
	FACTORY_STREAMS,
	type FactorySnapshot,
	type FactoryStreamData,
	type FactoryStreamName,
} from "../../lib/factory-types";
import { type AppVars, type Env, encryptionKey } from "../env";
import { getActiveAccount, touchLastUsedStmt } from "../lib/db/accounts";
import { readSnapshot, replaceSnapshotStmts } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";
import { newFactory, stepFactory, streamKey } from "../lib/factory-collect";
import { createGithubClient } from "../lib/github-client";
import { ACCOUNT_ID_RE } from "../lib/id";
import { readJson } from "../lib/read-body";
import { splitPages } from "../lib/snapshot-pages";
import { decryptToken, parseKeyBytes } from "../lib/token-crypto";
import { repoParts } from "./snapshots";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const PRIVATE = { "cache-control": "private, no-store" };
const input = z.object({
	account_id: z.string().regex(ACCOUNT_ID_RE),
	restart: z.boolean().optional(),
});

async function active(c: Ctx) {
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	return account;
}
export async function getFactory(c: Ctx): Promise<Response> {
	const account = await active(c);
	const snap = await readSnapshot(c.get("db"), account.id, "factory");
	if (!snap) throw new ApiError(409, "snapshot_missing", "no factory snapshot");
	return jsonOk({ ...snap, account_id: account.id }, 200, PRIVATE);
}
export async function getFactoryStream(c: Ctx): Promise<Response> {
	const account = await active(c);
	const { owner, name } = repoParts(c.req.param("owner") ?? "", c.req.param("name") ?? "");
	const stream = c.req.param("stream") as FactoryStreamName;
	if (!FACTORY_STREAMS.includes(stream))
		throw new ApiError(400, "validation_failed", "unknown stream");
	const page = Number(c.req.query("page") ?? "1");
	if (!Number.isInteger(page) || page < 1 || page > 50)
		throw new ApiError(400, "validation_failed", "invalid page");
	const snap = (await readSnapshot(c.get("db"), account.id, "factory")) as FactorySnapshot | null;
	const repo = snap?.repos.find((r) => r.name === `${owner}/${name}`);
	if (!repo || !snap) throw new ApiError(404, "not_found", "repository outside factory inventory");
	const resource =
		repo.coverage[stream].status === "pending"
			? null
			: ((await readSnapshot(
					c.get("db"),
					account.id,
					streamKey(repo.name, stream),
				)) as FactoryStreamData | null);
	const items = resource?.items ?? [];
	return jsonOk(
		{
			account_id: account.id,
			runId: snap.runId,
			repo: repo.name,
			stream,
			coverage: repo.coverage[stream],
			page,
			total: items.length,
			items: items.slice((page - 1) * 100, page * 100),
		},
		200,
		PRIVATE,
	);
}
export async function postFactoryRefresh(c: Ctx): Promise<Response> {
	const parsed = input.safeParse(await readJson(c.req.raw, 4096));
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid body");
	const account = await active(c);
	if (parsed.data.account_id !== account.id)
		throw new ApiError(409, "account_conflict", "account changed");
	const secret = encryptionKey(c.env, account.key_version);
	if (!secret) throw new ApiError(500, "encryption_misconfigured", "missing key");
	const token = await decryptToken(account.token_ciphertext, parseKeyBytes(secret));
	const db = c.get("db");
	const now = new Date().toISOString();
	const nonce = crypto.randomUUID();
	// D1's conditional upsert serializes tabs and Worker isolates. A crashed request expires in 5 min.
	const claimed = await db
		.prepare(`INSERT INTO snapshots (account_id, kind, payload, fetched_at) VALUES (?, 'factory:lock', ?, ?)
 ON CONFLICT(account_id, kind) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at WHERE snapshots.fetched_at <= ? RETURNING payload`)
		.bind(account.id, nonce, new Date(Date.parse(now) + 300000).toISOString(), now)
		.first<{ payload: string }>();
	if (claimed?.payload !== nonce)
		throw new ApiError(409, "account_conflict", "factory refresh already running; retry later");
	const unlock = () =>
		db
			.prepare(
				"DELETE FROM snapshots WHERE account_id = ? AND kind = 'factory:lock' AND payload = ?",
			)
			.bind(account.id, nonce);
	try {
		const old = (await readSnapshot(db, account.id, "factory")) as FactorySnapshot | null;
		const state = !old || parsed.data.restart ? newFactory(account.id, account.login, now) : old;
		const gh = createGithubClient(c.env);
		const staged = new Map<string, FactoryStreamData>();
		const store = {
			read: async (key: string) =>
				structuredClone(
					staged.get(key) ?? (await readSnapshot(db, account.id, key)),
				) as FactoryStreamData | null,
			write: async (key: string, data: FactoryStreamData) => {
				staged.set(key, structuredClone(data));
			},
		};
		// At most six pages, under both GitHub's 40-fetch and D1's 80-statement budgets.
		let failure: unknown;
		for (let i = 0; i < 6 && state.status !== "complete"; i++) {
			const checkpoint = structuredClone(state);
			try {
				await stepFactory(state, gh, token, store, new Date().toISOString());
			} catch (error) {
				Object.assign(state, checkpoint);
				failure = error;
				break;
			}
		}
		const serialized = { ...state };
		if (splitPages("factory", serialized).truncated)
			throw new ApiError(
				502,
				"github_error",
				"factory snapshot storage limit; previous snapshot retained",
			);
		const writes = [...staged].flatMap(([key, data]) =>
			replaceSnapshotStmts(db, account.id, key, { ...data }, now),
		);
		writes.push(...replaceSnapshotStmts(db, account.id, "factory", serialized, now));
		if (gh.count) writes.push(touchLastUsedStmt(db, account.id, now));
		await db.batch([...writes, unlock()]);
		if (failure) throw failure;
		return jsonOk(state, 200, PRIVATE);
	} catch (error) {
		await unlock().run();
		throw error;
	}
}
