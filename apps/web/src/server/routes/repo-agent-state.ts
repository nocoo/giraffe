import type { Context, Next } from "hono";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError } from "../lib/errors";
import { assertMachineQuery } from "../lib/machine-query";
import { readJson } from "../lib/read-body";
import { readRepoAgentState, writeRepoAgentState } from "../lib/repo-agent-state";
import type { MachineVars } from "./machine";
import { repoParts } from "./snapshots";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
export async function repoAgentStateHeaders(c: Ctx, next: Next) {
	await next();
	c.header("Cache-Control", "private, no-store");
	c.header("Referrer-Policy", "no-referrer");
	c.header(
		"Vary",
		c.req.path.startsWith("/api/v1/") ? "Authorization" : "Cookie, Cf-Access-Jwt-Assertion",
	);
}
function repository(c: Pick<Ctx, "req">) {
	assertMachineQuery(c.req.query());
	const { owner, name } = repoParts(c.req.param("owner") ?? "", c.req.param("name") ?? "");
	return `${owner}/${name}`;
}
export async function browserRepoAgentState(c: Ctx) {
	const name = repository(c);
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(409, "account_missing", "No active account");
	const state = await readRepoAgentState(c.get("db"), account.id, name);
	c.header("ETag", `"${state.revision ?? 0}"`);
	return c.json(state);
}
export async function machineRepoAgentState(c: Context<{ Bindings: Env; Variables: MachineVars }>) {
	if (c.req.method !== "GET" && c.req.method !== "PUT")
		throw new ApiError(405, "method_not_allowed", "Agent state supports GET and PUT");
	const name = repository(c);
	const principal = c.get("principal");
	let input: unknown;
	if (c.req.method === "PUT") {
		try {
			input = await readJson(c.req.raw, 100_000);
		} catch (error) {
			if (error instanceof ApiError && error.code === "validation_failed")
				throw new ApiError(
					400,
					error.message === "body too large" ? "payload_too_large" : "invalid_payload",
					"Invalid agent state body",
				);
			throw error;
		}
	}
	const state =
		c.req.method === "GET"
			? await readRepoAgentState(c.get("db"), principal.accountId, name)
			: await writeRepoAgentState(
					c.get("db"),
					principal.accountId,
					name,
					input,
					principal.id,
					c.req.header("If-Match"),
				);
	c.header("ETag", `"${state.revision ?? 0}"`);
	return c.json(state);
}
