import { type Context, Hono } from "hono";
import { type AppVars, type Env, envMode } from "./env";
import { createDb } from "./lib/db/d1";
import { jsonError, toErrorResponse } from "./lib/errors";
import { SourceTiming } from "./lib/source-timing";
import { accessBypass, resolveIdentity } from "./middleware/access";
import { assertOrigin } from "./middleware/origin";
import { scheduleRefresh } from "./refresh-runner";
import { activateAccount, getAccounts, postAccount, removeAccount } from "./routes/accounts";
import { activityEtag, getActivity } from "./routes/activity";
import { browserTokens } from "./routes/api-tokens";
import { getCi } from "./routes/ci";
import { getFactory, getFactoryStream } from "./routes/factory";
import { liveResponse } from "./routes/live";
import { machineApi } from "./routes/machine";
import { getMe } from "./routes/me";
import { postRead, postReadAll } from "./routes/notifications";
import { getProjectIdentity } from "./routes/project-identity";
import { browserRefresh } from "./routes/refresh";
import { browserRepoAgentState, repoAgentStateHeaders } from "./routes/repo-agent-state";
import { browserRepoMeta, repoMetaHeaders } from "./routes/repo-meta";
import { repoGet, setRepoStar, setRepoStatistics } from "./routes/repos";
import { snapshotGet } from "./routes/snapshots";

export { RefreshRunner } from "./refresh-runner";

function notAllowed(): Response {
	return jsonError(405, "method_not_allowed", "method not allowed");
}

function allow(
	app: Hono<{ Bindings: Env; Variables: AppVars }>,
	path: string,
	methods: string[],
): void {
	app.all(path, async (c, next) => {
		if (!methods.includes(c.req.raw.method)) {
			return notAllowed();
		}
		await next();
	});
}

function onGet(
	app: Hono<{ Bindings: Env; Variables: AppVars }>,
	path: string,
	handler: (c: Context<{ Bindings: Env; Variables: AppVars }>) => Response | Promise<Response>,
): void {
	app.on("GET", path, handler);
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
	app.use("/api/*", async (c, next) => {
		if (c.req.path.startsWith("/api/v1/")) {
			await next();
			return;
		}
		const timing =
			c.req.method === "GET" &&
			/^\/api\/(?:repos(?:\/|$)|issues$|prs$|ci$|factory(?:\/|$))/.test(c.req.path)
				? new SourceTiming()
				: undefined;
		c.set("sourceTiming", timing);
		c.set("db", createDb(c.env.DB, timing?.recordD1.bind(timing)));
		const liveGet = c.req.path === "/api/live" && c.req.raw.method === "GET";
		if (!liveGet) {
			const authenticate = () => resolveIdentity(c.req.raw, c.env);
			c.set(
				"identity",
				timing ? await timing.measureAsync("auth", authenticate) : await authenticate(),
			);
			assertOrigin(c.req.raw, envMode(c.env.ENVIRONMENT), accessBypass(c.env));
		}
		if (timing) await timing.measureAsync("build", next);
		else await next();
		if (timing && (c.res.status === 200 || c.res.status === 304))
			c.header("Server-Timing", timing.header());
	});
	app.route("/api/v1", machineApi());
	app.all("/api/refresh-runs", browserRefresh);
	app.all("/api/refresh-runs/:id", browserRefresh);
	allow(app, "/api/activity", ["GET"]);
	app.get("/api/activity", activityEtag, getActivity);
	allow(app, "/api/tokens", ["GET", "POST"]);
	app.on(["GET", "POST"], "/api/tokens", browserTokens);
	allow(app, "/api/tokens/:id", ["PATCH", "DELETE"]);
	app.on(["PATCH", "DELETE"], "/api/tokens/:id", browserTokens);
	allow(app, "/api/live", ["GET"]);
	onGet(app, "/api/live", (c) => liveResponse(c.env, c.get("db")));
	allow(app, "/api/me", ["GET"]);
	onGet(app, "/api/me", (c) => getMe(c));
	allow(app, "/api/projects/:owner/:repo", ["GET"]);
	onGet(app, "/api/projects/:owner/:repo", getProjectIdentity);
	allow(app, "/api/accounts", ["GET", "POST"]);
	onGet(app, "/api/accounts", (c) => getAccounts(c));
	app.post("/api/accounts", (c) => postAccount(c));
	allow(app, "/api/accounts/:id/activate", ["POST"]);
	app.post("/api/accounts/:id/activate", (c) => activateAccount(c));
	allow(app, "/api/accounts/:id", ["DELETE"]);
	app.delete("/api/accounts/:id", (c) => removeAccount(c));
	allow(app, "/api/repos/:owner/:name/star", ["POST"]);
	app.post("/api/repos/:owner/:name/star", setRepoStar);
	allow(app, "/api/factory", ["GET"]);
	onGet(app, "/api/factory", getFactory);
	allow(app, "/api/factory/repos/:owner/:name/:stream", ["GET"]);
	onGet(app, "/api/factory/repos/:owner/:name/:stream", getFactoryStream);
	allow(app, "/api/ci", ["GET"]);
	onGet(app, "/api/ci", getCi);
	allow(app, "/api/repos", ["GET"]);
	allow(app, "/api/repos/:owner/:name/statistics", ["POST"]);
	app.post("/api/repos/:owner/:name/statistics", setRepoStatistics);
	onGet(app, "/api/repos", (c) => snapshotGet(c, "repos"));
	allow(app, "/api/issues", ["GET"]);
	onGet(app, "/api/issues", (c) => snapshotGet(c, "issues"));
	allow(app, "/api/prs", ["GET"]);
	onGet(app, "/api/prs", (c) => snapshotGet(c, "prs"));
	allow(app, "/api/insights", ["GET"]);
	onGet(app, "/api/insights", (c) => snapshotGet(c, "insights"));
	allow(app, "/api/alerts", ["GET"]);
	onGet(app, "/api/alerts", (c) => snapshotGet(c, "alerts"));
	allow(app, "/api/notifications", ["GET"]);
	onGet(app, "/api/notifications", (c) => snapshotGet(c, "notifications"));
	allow(app, "/api/repos/:owner/:name/agent-state", ["GET"]);
	app.get("/api/repos/:owner/:name/agent-state", repoAgentStateHeaders, browserRepoAgentState);
	allow(app, "/api/repos/:owner/:name/meta", ["GET"]);
	app.get("/api/repos/:owner/:name/meta", repoMetaHeaders, browserRepoMeta);
	allow(app, "/api/repos/:owner/:name", ["GET"]);
	onGet(app, "/api/repos/:owner/:name", (c) => repoGet(c, "details"));
	allow(app, "/api/repos/:owner/:name/actions", ["GET"]);
	onGet(app, "/api/repos/:owner/:name/actions", (c) => repoGet(c, "actions"));
	allow(app, "/api/repos/:owner/:name/traffic", ["GET"]);
	onGet(app, "/api/repos/:owner/:name/traffic", (c) => repoGet(c, "traffic"));
	allow(app, "/api/repos/:owner/:name/security", ["GET"]);
	onGet(app, "/api/repos/:owner/:name/security", (c) => repoGet(c, "security"));
	allow(app, "/api/repos/:owner/:name/issues", ["GET"]);
	onGet(app, "/api/repos/:owner/:name/issues", (c) => repoGet(c, "issues"));
	allow(app, "/api/repos/:owner/:name/prs", ["GET"]);
	onGet(app, "/api/repos/:owner/:name/prs", (c) => repoGet(c, "prs"));
	allow(app, "/api/repos/:owner/:name/releases", ["GET"]);
	onGet(app, "/api/repos/:owner/:name/releases", (c) => repoGet(c, "releases"));
	allow(app, "/api/repos/:owner/:name/languages", ["GET"]);
	onGet(app, "/api/repos/:owner/:name/languages", (c) => repoGet(c, "languages"));
	allow(app, "/api/repos/:owner/:name/contributors", ["GET"]);
	onGet(app, "/api/repos/:owner/:name/contributors", (c) => repoGet(c, "contributors"));
	allow(app, "/api/notifications/read", ["POST"]);
	app.post("/api/notifications/read", (c) => postRead(c));
	allow(app, "/api/notifications/read-all", ["POST"]);
	app.post("/api/notifications/read-all", (c) => postReadAll(c));
	return app;
}

const app = createApp();

export default {
	scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(scheduleRefresh(env, event.scheduledTime));
	},
	fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/api" || path.startsWith("/api/")) {
			return app.fetch(request, env, ctx);
		}
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
