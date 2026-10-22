import { Hono } from "hono";
import { resourceCollection, resourceId } from "../../lib/agent-resource";
import type { AppVars, Env } from "../env";
import {
	createResource,
	deleteResource,
	getResource,
	listResources,
	updateResource,
} from "../lib/agent-resources";
import { readAnalysisReports } from "../lib/analysis-reports";
import { getActiveAccount } from "../lib/db/accounts";
import { ApiError } from "../lib/errors";
import { readSources } from "../lib/machine-sources";
import { readJson } from "../lib/read-body";
import { repoPolicy } from "../lib/snapshot-projection";
import { dailyReportHistory, latestReport } from "./report-latest";

export function agentBrowserApi() {
	const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
	app.use("/accounts/:account/*", async (c, next) => {
		const active = await getActiveAccount(c.get("db"));
		if (!active) throw new ApiError(409, "account_missing", "active account required");
		if (active.id !== c.req.param("account"))
			throw new ApiError(409, "account_conflict", "account changed");
		c.header("cache-control", "private, no-store");
		await next();
	});
	app.get("/accounts/:account/sources", async (c) => {
		const account = String(c.req.param("account"));
		const result = await readSources(c.get("db"), account, c.req.query());
		const active = await getActiveAccount(c.get("db"));
		const policy = await repoPolicy(c.get("db"), account);
		const repositories = policy.repos
			.filter(
				(repo) =>
					repo.owner_login === active?.login && repo.is_archived !== true && repo.is_fork !== true,
			)
			.map((repo) => repo.name_with_owner)
			.sort();
		return c.json({ ...result, repositories });
	});
	app.get("/accounts/:account/analysis/reports", async (c) => {
		if (Object.keys(c.req.query()).length)
			throw new ApiError(400, "validation_failed", "unexpected query parameters");
		return c.json(await readAnalysisReports(c.get("db"), String(c.req.param("account"))));
	});
	app.get("/accounts/:account/reports/latest", latestReport);
	app.all("/accounts/:account/analysis/daily", dailyReportHistory);
	app.all("/accounts/:account/:collection/:id?", async (c) => {
		const parsed = resourceCollection.safeParse(c.req.param("collection"));
		const id = c.req.param("id");
		if (!parsed.success || (id && !resourceId.safeParse(id).success))
			throw new ApiError(404, "not_found", "unknown resource");
		const db = c.get("db"),
			account = String(c.req.param("account")),
			kind = parsed.data,
			method = c.req.method;
		if (method === "GET" && !id)
			return c.json(await listResources(db, account, kind, c.req.query()));
		if (method === "GET" && id) {
			const item = await getResource(db, account, kind, id);
			if (!item) throw new ApiError(404, "not_found", "resource missing");
			return c.json({ account_id: account, item });
		}
		if (method === "POST" && !id) {
			const body = await readJson(c.req.raw, 70000);
			const item = await createResource(db, account, kind, body);
			return c.json(
				{ account_id: account, item },
				kind === "reports" && item.type === "github-daily" && item.revision > 1 ? 200 : 201,
			);
		}
		if (method === "PATCH" && id)
			return c.json({
				account_id: account,
				item: await updateResource(db, account, kind, id, await readJson(c.req.raw, 70000)),
			});
		if (method === "DELETE" && id) {
			await deleteResource(db, account, kind, id, Number(c.req.query("revision")));
			return c.body(null, 204);
		}
		throw new ApiError(405, "method_not_allowed", "method not allowed");
	});
	return app;
}
