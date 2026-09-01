import { Hono } from "hono";
import { type Env, envMode } from "./env";
import type { Identity } from "./lib/access-identity";
import { createDb, type Db } from "./lib/db/d1";
import { jsonError, toErrorResponse } from "./lib/errors";
import { resolveIdentity } from "./middleware/access";
import { assertOrigin } from "./middleware/origin";
import { liveResponse } from "./routes/live";

export type AppVars = {
	db: Db;
	identity: Identity;
};

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
	app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/live", () =>
		jsonError(405, "method_not_allowed", "method not allowed"),
	);
	app.use("/api/*", async (c, next) => {
		c.set("db", createDb(c.env.DB));
		c.set("identity", await resolveIdentity(c.req.raw, c.env));
		assertOrigin(c.req.raw, envMode(c.env.ENVIRONMENT));
		await next();
	});
	app.get("/api/me", (c) => c.json(c.get("identity")));
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
