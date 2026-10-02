import { Hono } from "hono";
import { z } from "zod";
import { resourceCollection, resourceId } from "../../lib/agent-resource";
import { REPO_SNAPSHOT_TABS } from "../../lib/snapshot-kinds";
import type { AppVars, Env } from "../env";
import {
	createResource,
	deleteResource,
	getResource,
	listResources,
	updateResource,
} from "../lib/agent-resources";
import {
	authenticateApiToken,
	exchangeAuthorizationCode,
	recordApiTokenUse,
} from "../lib/api-tokens";
import { getAccount } from "../lib/db/accounts";
import { createDb } from "../lib/db/d1";
import { ApiError, jsonOk } from "../lib/errors";
import {
	readFactoryResource,
	readObservation,
	requireCatalogRepo,
} from "../lib/machine-observations";
import { readJson } from "../lib/read-body";
import { snapshotScope } from "../lib/snapshot-scope";
import { getMachineSettings, machineRuns, machineSetting } from "./machine-settings";

type Principal = NonNullable<Awaited<ReturnType<typeof authenticateApiToken>>>;
export type MachineVars = AppVars & { principal: Principal };
export function machineApi() {
	const app = new Hono<{ Bindings: Env; Variables: MachineVars }>();
	app.use("*", async (c, next) => {
		c.set("db", createDb(c.env.DB));
		c.header("Cache-Control", "private, no-store");
		c.header("Referrer-Policy", "no-referrer");
		const exchange = c.req.path === "/api/v1/auth/exchange";
		if (exchange) {
			if (c.req.method !== "POST")
				throw new ApiError(405, "method_not_allowed", "method not allowed");
			await next();
			return;
		}
		const principal = await authenticateApiToken(
			c.get("db"),
			c.req.header("Authorization") ?? null,
		);
		if (!principal) throw new ApiError(401, "token_unauthorized", "invalid API token");
		c.set("principal", principal);
		const account = c.req.path.match(/^\/api\/v1\/accounts\/([^/]+)/)?.[1];
		if (account && decodeURIComponent(account) !== principal.accountId)
			throw new ApiError(403, "account_forbidden", "token belongs to another account");
		if (c.req.path !== "/api/v1/me") {
			const read = c.req.method === "GET";
			const agent = /\/agent\//.test(c.req.path);
			const management =
				/\/accounts\/[^/]+\/(settings|stars|statistics|schedules|refresh-runs)(\/|$)/.test(
					c.req.path,
				);
			const scope = agent
				? read
					? "agent:read"
					: "agent:write"
				: management
					? read
						? "app:read"
						: "app:write"
					: "observations:read";
			if (!principal.scopes.includes(scope))
				throw new ApiError(403, "scope_forbidden", "scope required");
			if (!read && !agent && !management)
				throw new ApiError(405, "method_not_allowed", "observations are read-only");
		}
		await next();
		if (!["GET", "HEAD"].includes(c.req.method) && c.res.status < 400)
			await recordApiTokenUse(c.get("db"), principal.accountId, principal.id);
	});
	app.post("/auth/exchange", async (c) => {
		const raw = await readJson(c.req.raw, 4096);
		const parsed = z
			.object({ code: z.string(), code_verifier: z.string(), redirect_uri: z.string() })
			.strict()
			.safeParse(raw);
		if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid exchange");
		const value = await exchangeAuthorizationCode(c.get("db"), {
			code: parsed.data.code,
			codeVerifier: parsed.data.code_verifier,
			redirectUri: parsed.data.redirect_uri,
		});
		return jsonOk({
			token: value.token,
			account_id: value.account_id,
			expires_at: value.expires_at,
			scopes: value.scopes,
		});
	});
	app.get("/me", async (c) => {
		const p = c.get("principal");
		const account = await getAccount(c.get("db"), p.accountId);
		if (!account) throw new ApiError(401, "token_unauthorized", "account unavailable");
		return c.json({
			account_id: p.accountId,
			login: account.login,
			token: { id: p.id, scopes: p.scopes, expires_at: p.expiresAt },
			capabilities: {
				observations: p.scopes.includes("observations:read"),
				agentRead: p.scopes.includes("agent:read"),
				agentWrite: p.scopes.includes("agent:write"),
				appRead: p.scopes.includes("app:read"),
				appWrite: p.scopes.includes("app:write"),
			},
		});
	});
	app.all("/accounts/:account/agent/:collection/:id?", async (c) => {
		const kind = resourceCollection.safeParse(c.req.param("collection"));
		const id = c.req.param("id");
		if (!kind.success || (id && !resourceId.safeParse(id).success))
			throw new ApiError(404, "not_found", "unknown resource");
		const db = c.get("db");
		const account = c.get("principal").accountId;
		const method = c.req.method;
		if (method === "GET" && !id)
			return c.json(await listResources(db, account, kind.data, c.req.query()));
		if (method === "GET" && id) {
			const item = await getResource(db, account, kind.data, id);
			if (!item) throw new ApiError(404, "not_found", "resource not found");
			return c.json({ account_id: account, item });
		}
		if (method === "POST" && !id)
			return c.json(
				{
					account_id: account,
					item: await createResource(db, account, kind.data, await readJson(c.req.raw, 70000)),
				},
				201,
			);
		if (method === "PATCH" && id)
			return c.json({
				account_id: account,
				item: await updateResource(db, account, kind.data, id, await readJson(c.req.raw, 70000)),
			});
		if (method === "DELETE" && id) {
			await deleteResource(db, account, kind.data, id, Number(c.req.query("revision")));
			return c.body(null, 204);
		}
		throw new ApiError(405, "method_not_allowed", "method not allowed");
	});
	app.get("/accounts/:account/settings", getMachineSettings);
	app.all("/accounts/:account/stars/:owner/:name", machineSetting);
	app.all("/accounts/:account/statistics/:owner/:name", machineSetting);
	app.all("/accounts/:account/schedules/:kind", machineSetting);
	app.all("/accounts/:account/refresh-runs", machineRuns);
	app.all("/accounts/:account/refresh-runs/:id/control", machineRuns);
	app.get("/accounts/:account/factory/repos/:owner/:name/:stream", async (c) =>
		c.json(
			await readFactoryResource(
				c.get("db"),
				c.get("principal").accountId,
				await requireCatalogRepo(
					c.get("db"),
					c.get("principal").accountId,
					`${c.req.param("owner")}/${c.req.param("name")}`,
				),
				c.req.param("stream"),
			),
		),
	);
	app.get("/accounts/:account/repos/:owner/:name/:resource?", async (c) => {
		const resource = c.req.param("resource") ?? "details";
		if (!REPO_SNAPSHOT_TABS.includes(resource as (typeof REPO_SNAPSHOT_TABS)[number]))
			throw new ApiError(404, "not_found", "unknown source");
		const p = c.get("principal");
		const name = await requireCatalogRepo(
			c.get("db"),
			p.accountId,
			`${c.req.param("owner")}/${c.req.param("name")}`,
		);
		return c.json(
			await readObservation(c.get("db"), p.accountId, `repo:${name}:${resource}`, "all"),
		);
	});
	app.get("/accounts/:account/:resource", async (c) => {
		const kind = c.req.param("resource");
		if (!["repos", "issues", "prs", "ci", "factory"].includes(kind))
			throw new ApiError(404, "not_found", "unknown source");
		return c.json(
			await readObservation(
				c.get("db"),
				c.get("principal").accountId,
				kind,
				snapshotScope(c.req.queries("scope")),
			),
		);
	});
	app.notFound(() => {
		throw new ApiError(404, "not_found", "unknown machine endpoint");
	});
	return app;
}
