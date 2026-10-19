import type { Context } from "hono";
import { z } from "zod";
import type { AppVars, Env } from "../env";
import { createApiToken, listApiTokens, revokeApiToken, updateApiToken } from "../lib/api-tokens";
import { getAccount } from "../lib/db/accounts";
import { ApiError } from "../lib/errors";
import { readJson } from "../lib/read-body";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const accountInput = z.string().regex(/^[A-Za-z0-9_-]{21}$/);
async function account(c: Ctx, id: unknown) {
	const parsed = accountInput.safeParse(id);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "account required");
	if (!(await getAccount(c.get("db"), parsed.data)))
		throw new ApiError(404, "not_found", "account not found");
	return parsed.data;
}
export async function browserTokens(c: Ctx) {
	c.header("Cache-Control", "private, no-store");
	c.header("Referrer-Policy", "no-referrer");
	const id = c.req.param("id");
	const method = c.req.method;
	if (method === "GET" && !id) {
		const a = await account(c, c.req.query("account_id"));
		return c.json({ account_id: a, items: await listApiTokens(c.get("db"), a) });
	}
	const body = await readJson(c.req.raw, 8192);
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new ApiError(400, "validation_failed", "invalid token request");
	const { account_id, ...input } = body as Record<string, unknown>;
	const a = await account(c, account_id);
	if (method === "POST" && !id) {
		const p = z
			.object({
				label: z.string(),
				scopes: z.array(z.string()),
				expires_in_days: z.number().optional(),
			})
			.strict()
			.safeParse(input);
		if (!p.success) throw new ApiError(400, "validation_failed", "invalid token request");
		return c.json(
			await createApiToken(c.get("db"), {
				accountId: a,
				label: p.data.label,
				scopes: p.data.scopes,
				expiresInDays: p.data.expires_in_days ?? 30,
				creator: c.get("identity").email,
			}),
			201,
		);
	}
	if (method === "PATCH" && id) {
		const item = await updateApiToken(c.get("db"), a, id, input);
		if (!item) throw new ApiError(404, "not_found", "token unavailable");
		return c.json(item);
	}
	if (method === "DELETE" && id) {
		if (Object.keys(input).length) throw new ApiError(400, "validation_failed", "invalid revoke");
		if (!(await revokeApiToken(c.get("db"), a, id)))
			throw new ApiError(404, "not_found", "token unavailable");
		return c.body(null, 204);
	}
	throw new ApiError(405, "method_not_allowed", "method not allowed");
}
