import type { Context } from "hono";
import { z } from "zod";
import { type AppVars, type Env, encryptionKey } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { createGithubClient } from "../lib/github-client";
import { ACCOUNT_ID_RE } from "../lib/id";
import { readJson } from "../lib/read-body";
import { assertRefreshCapabilities, expandKinds, prepareRefresh } from "../lib/refresh";
import { statisticsSnapshot } from "../lib/repo-statistics";
import { decryptToken, parseKeyBytes } from "../lib/token-crypto";

const bodySchema = z.object({
	account_id: z.string().regex(ACCOUNT_ID_RE),
	kinds: z.union([z.literal("all"), z.array(z.string())]).optional(),
});

// Compatibility endpoint; the UI starts durable factory runs instead.
export async function postRefresh(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
): Promise<Response> {
	const parsed = bodySchema.safeParse(await readJson(c.req.raw, 65_536));
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid body");
	const requested = expandKinds(parsed.data.kinds);
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	if (parsed.data.account_id !== account.id)
		throw new ApiError(409, "account_conflict", "account changed");
	const secret = encryptionKey(c.env, account.key_version);
	if (!secret) throw new ApiError(500, "encryption_misconfigured", "missing key");
	assertRefreshCapabilities(account.capabilities, requested);
	const token = await decryptToken(account.token_ciphertext, parseKeyBytes(secret));
	const fetchedAt = new Date().toISOString();
	const { written, stmts } = await prepareRefresh(
		db,
		account.id,
		createGithubClient(c.env),
		token,
		requested,
		fetchedAt,
	);
	await db.batch(stmts);
	if (requested.length === 1)
		return jsonOk({
			...(await statisticsSnapshot(
				db,
				account.id,
				requested[0] as string,
				written[requested[0] as string] ?? {},
			)),
			account_id: account.id,
		});
	return jsonOk({
		account_id: account.id,
		fetched_at: fetchedAt,
		kinds: Object.keys(written),
		truncated_kinds: Object.keys(written).filter((kind) => written[kind]?.truncated === true),
	});
}
