import { type Context, Hono } from "hono";
import { type AppVars, type Env, envMode } from "./env";
import { createDb } from "./lib/db/d1";
import { jsonError, toErrorResponse } from "./lib/errors";
import { resolveIdentity } from "./middleware/access";
import { assertOrigin } from "./middleware/origin";
import { activateAccount, getAccounts, postAccount, removeAccount } from "./routes/accounts";
import { liveResponse } from "./routes/live";
import { postRead, postReadAll } from "./routes/notifications";
import { postRefresh } from "./routes/refresh";
import { repoParts, snapshotGet } from "./routes/snapshots";

function notAllowed(): Response {
	return jsonError(405, "method_not_allowed", "method not allowed");
}

function allow(
	app: Hono<{ Bindings: Env; Variables: AppVars }>,
	path: string,
	methods: string[],
): void {
	const blocked = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter(
		(method) => !methods.includes(method),
	);
	app.on(blocked, path, () => notAllowed());
}

function repoGet(
	c: Context<{ Bindings: Env; Variables: AppVars }>,
	suffix: string,
): Promise<Response> {
	const { owner, name } = repoParts(String(c.req.param("owner")), String(c.req.param("name")));
	return snapshotGet(c, `repo:${owner}/${name}:${suffix}`);
}

export function createApp(): Hono<{ Bindings: Env; Variables: AppVars }> {
	const app = new Hono<{ Bindings: Env; Variables: AppVars }>();
	app.onError((err) => toErrorResponse(err));
	app.notFound((c) => {
		if (c.req.path.startsWith("/api")) {
			return jsonError(404, "not_found", "not found");
		}
		return c.env.ASSETS.fetch(c.req.raw);
	});
	app.get("/api/live", async (c) => liveResponse(c.env, createDb(c.env.DB)));
	allow(app, "/api/live", ["GET"]);
	app.use("/api/*", async (c, next) => {
		c.set("db", createDb(c.env.DB));
		c.set("identity", await resolveIdentity(c.req.raw, c.env));
		assertOrigin(c.req.raw, envMode(c.env.ENVIRONMENT));
		await next();
	});
	app.get("/api/me", (c) => c.json(c.get("identity")));
	allow(app, "/api/me", ["GET"]);
	app.get("/api/accounts", (c) => getAccounts(c));
	app.post("/api/accounts", (c) => postAccount(c));
	allow(app, "/api/accounts", ["GET", "POST"]);
	app.post("/api/accounts/:id/activate", (c) => activateAccount(c));
	allow(app, "/api/accounts/:id/activate", ["POST"]);
	app.delete("/api/accounts/:id", (c) => removeAccount(c));
	allow(app, "/api/accounts/:id", ["DELETE"]);
	app.post("/api/refresh", (c) => postRefresh(c));
	allow(app, "/api/refresh", ["POST"]);
	app.get("/api/repos", (c) => snapshotGet(c, "repos"));
	allow(app, "/api/repos", ["GET"]);
	app.get("/api/issues", (c) => snapshotGet(c, "issues"));
	allow(app, "/api/issues", ["GET"]);
	app.get("/api/prs", (c) => snapshotGet(c, "prs"));
	allow(app, "/api/prs", ["GET"]);
	app.get("/api/insights", (c) => snapshotGet(c, "insights"));
	allow(app, "/api/insights", ["GET"]);
	app.get("/api/alerts", (c) => snapshotGet(c, "alerts"));
	allow(app, "/api/alerts", ["GET"]);
	app.get("/api/notifications", (c) => snapshotGet(c, "notifications"));
	allow(app, "/api/notifications", ["GET"]);
	app.get("/api/digest", (c) => snapshotGet(c, "digest"));
	allow(app, "/api/digest", ["GET"]);
	app.get("/api/repos/:owner/:name", (c) => repoGet(c, "details"));
	allow(app, "/api/repos/:owner/:name", ["GET"]);
	app.get("/api/repos/:owner/:name/actions", (c) => repoGet(c, "actions"));
	allow(app, "/api/repos/:owner/:name/actions", ["GET"]);
	app.get("/api/repos/:owner/:name/traffic", (c) => repoGet(c, "traffic"));
	allow(app, "/api/repos/:owner/:name/traffic", ["GET"]);
	app.get("/api/repos/:owner/:name/security", (c) => repoGet(c, "security"));
	allow(app, "/api/repos/:owner/:name/security", ["GET"]);
	app.get("/api/repos/:owner/:name/issues", (c) => repoGet(c, "issues"));
	allow(app, "/api/repos/:owner/:name/issues", ["GET"]);
	app.get("/api/repos/:owner/:name/prs", (c) => repoGet(c, "prs"));
	allow(app, "/api/repos/:owner/:name/prs", ["GET"]);
	app.get("/api/repos/:owner/:name/releases", (c) => repoGet(c, "releases"));
	allow(app, "/api/repos/:owner/:name/releases", ["GET"]);
	app.get("/api/repos/:owner/:name/languages", (c) => repoGet(c, "languages"));
	allow(app, "/api/repos/:owner/:name/languages", ["GET"]);
	app.get("/api/repos/:owner/:name/contributors", (c) => repoGet(c, "contributors"));
	allow(app, "/api/repos/:owner/:name/contributors", ["GET"]);
	app.post("/api/notifications/read", (c) => postRead(c));
	allow(app, "/api/notifications/read", ["POST"]);
	app.post("/api/notifications/read-all", (c) => postReadAll(c));
	allow(app, "/api/notifications/read-all", ["POST"]);
	return app;
}

const app = createApp();

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/api" || path.startsWith("/api/")) {
			return app.fetch(request, env, ctx);
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
