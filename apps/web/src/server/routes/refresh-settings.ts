import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { ACCOUNT_ID_RE } from "../lib/id";
import { readJson } from "../lib/read-body";
import { readScheduleSettings, saveSchedule } from "../lib/refresh-schedule";
import { normalizeScheduleConfig, scheduleConfigInput } from "../lib/refresh-schedule-input";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const configInput = scheduleConfigInput
	.safeExtend({
		account_id: z.string().regex(ACCOUNT_ID_RE),
	})
	.strict();
export async function getRefreshSettings(c: Ctx): Promise<Response> {
	const db = c.get("db");
	const account = await getActiveAccount(db);
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	const settings = await readScheduleSettings(db, account.id);
	return jsonOk(
		{
			account_id: account.id,
			schedules: settings.schedules,
			starred: settings.stars,
		},
		200,
		{ "cache-control": "private, no-store" },
		c.get("sourceTiming"),
	);
}
export async function postRefreshSchedule(c: Ctx): Promise<Response> {
	const kind = c.req.param("kind");
	const parsed = configInput.safeParse(await readJson(c.req.raw, 2048));
	if (
		(kind !== "daily" && kind !== "weekly" && kind !== "catalog") ||
		!parsed.success ||
		(kind === "daily" && parsed.data.scope !== "starred") ||
		(kind === "catalog" && (parsed.data.scope !== "all" || parsed.data.weekday !== 0))
	)
		throw new ApiError(400, "validation_failed", "invalid schedule");
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	if (account.id !== parsed.data.account_id)
		throw new ApiError(409, "account_conflict", "account changed");
	await saveSchedule(
		c.get("db"),
		account.id,
		kind,
		normalizeScheduleConfig(parsed.data),
		new Date().toISOString(),
	);
	return getRefreshSettings(c);
}
