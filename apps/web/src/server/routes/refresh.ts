import type { Context } from "hono";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError } from "../lib/errors";
import { assertMachineQuery } from "../lib/machine-query";
import { readJson } from "../lib/read-body";
import { getRefreshRun, listRefreshRuns, terminalRefreshStatus } from "../lib/refresh-store";
import { timedJson } from "../lib/timed-json";
import { cancelRefresh, startRefresh } from "../refresh-runner";
import type { MachineVars } from "./machine";

async function refreshResponse<Variables extends AppVars>(
	c: Context<{ Bindings: Env; Variables: Variables }>,
	account: string,
) {
	const id = c.req.param("id");
	const cancelling = id !== undefined && c.req.path.endsWith("/cancel");
	assertMachineQuery(c.req.query());
	c.header("Cache-Control", "private, no-store");
	if (cancelling) {
		if (c.req.method !== "POST")
			throw new ApiError(405, "method_not_allowed", "method not allowed");
		const run = await cancelRefresh(c.env, account, id);
		return c.json(run, terminalRefreshStatus(run.status) ? 200 : 202);
	}
	if (c.req.method !== "GET" && (c.req.method !== "POST" || id))
		throw new ApiError(405, "method_not_allowed", "method not allowed");
	if (c.req.method === "POST")
		return c.json(
			await startRefresh(c.env, account, (await readJson(c.req.raw, 4096, true)) ?? {}),
			202,
		);
	if (id) {
		const run =
			id === "latest"
				? (await listRefreshRuns(c.get("db"), account))[0]
				: await getRefreshRun(c.get("db"), account, id);
		if (!run)
			throw new ApiError(
				id === "latest" ? 409 : 404,
				id === "latest" ? "snapshot_missing" : "not_found",
				"refresh run missing",
			);
		return timedJson(c, run);
	}
	return timedJson(c, {
		items: await listRefreshRuns(c.get("db"), account),
		collectionAvailable: true,
	});
}
export async function browserRefresh(c: Context<{ Bindings: Env; Variables: AppVars }>) {
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(404, "account_missing", "no active account");
	return refreshResponse(c, account.id);
}
export async function machineRefresh(c: Context<{ Bindings: Env; Variables: MachineVars }>) {
	return refreshResponse(c, c.get("principal").accountId);
}
