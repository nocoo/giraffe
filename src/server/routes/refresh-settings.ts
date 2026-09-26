import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { ACCOUNT_ID_RE } from "../lib/id";
import { readJson } from "../lib/read-body";
import { readSchedules, saveSchedule, starredRepos } from "../lib/refresh-schedule";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const configInput = z
	.object({
		account_id: z.string().regex(ACCOUNT_ID_RE),
		enabled: z.boolean(),
		time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
		weekday: z.number().int().min(0).max(6),
		scope: z.enum(["all", "starred"]),
	})
	.strict();
export async function getRefreshSettings(c: Ctx): Promise<Response> {
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	return jsonOk(
		{
			account_id: account.id,
			schedules: await readSchedules(db, account.id),
			starred: await starredRepos(db, account.id),
		},
		200,
		{ "cache-control": "private, no-store" },
	);
}
export async function postRefreshSchedule(c: Ctx): Promise<Response> {
	const kind = c.req.param("kind");
	const parsed = configInput.safeParse(await readJson(c.req.raw, 2048));
	if (
		(kind !== "daily" && kind !== "weekly") ||
		!parsed.success ||
		(kind === "daily" && parsed.data.scope !== "starred")
	)
		throw new ApiError(400, "validation_failed", "invalid schedule");
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	if (account.id !== parsed.data.account_id)
		throw new ApiError(409, "account_conflict", "account changed");
	await saveSchedule(c.get("db"), account.id, kind, parsed.data, new Date().toISOString());
	return getRefreshSettings(c);
}
