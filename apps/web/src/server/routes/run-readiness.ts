import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError, jsonOk } from "../lib/errors";
import { readLatestRun } from "../lib/run-readiness";
import type { MachineVars } from "./machine";

const PRIVATE = { "cache-control": "private, no-store" };

export async function getLatestRun(c: Context<{ Bindings: Env; Variables: AppVars }>) {
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(409, "account_missing", "No active account");
	return jsonOk(await readLatestRun(c.get("db"), account.id, c.req.queries()), 200, PRIVATE);
}

export async function getMachineLatestRun(c: Context<{ Bindings: Env; Variables: MachineVars }>) {
	if (c.req.method !== "GET") throw new ApiError(405, "method_not_allowed", "Runs are read-only");
	return c.json(await readLatestRun(c.get("db"), c.get("principal").accountId, c.req.queries()));
}
