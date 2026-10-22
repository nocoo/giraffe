import type { Context, Next } from "hono";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError } from "../lib/errors";
import { assertMachineQuery } from "../lib/machine-query";
import { readJson } from "../lib/read-body";
import { readRepoMeta, writeRepoMeta } from "../lib/repo-meta";
import type { MachineVars } from "./machine";
import { repoParts } from "./snapshots";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
export async function repoMetaHeaders(c: Ctx, next: Next) {
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
export async function browserRepoMeta(c: Ctx) {
	const name = repository(c);
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(409, "account_missing", "No active account");
	return c.json(await readRepoMeta(c.get("db"), account.id, name));
}
export async function machineRepoMeta(c: Context<{ Bindings: Env; Variables: MachineVars }>) {
	if (c.req.method !== "GET" && c.req.method !== "PUT")
		throw new ApiError(405, "method_not_allowed", "Repository metadata supports GET and PUT");
	const name = repository(c);
	const account = c.get("principal").accountId;
	if (c.req.method === "GET") return c.json(await readRepoMeta(c.get("db"), account, name));
	let input: unknown;
	try {
		input = await readJson(c.req.raw, 4096);
	} catch (error) {
		if (error instanceof ApiError && error.code === "validation_failed")
			throw new ApiError(400, "invalid_payload", "Invalid repository metadata body");
		throw error;
	}
	return c.json(await writeRepoMeta(c.get("db"), account, name, input));
}
