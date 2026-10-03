import { Hono } from "hono";
import { resourceCollection, resourceId } from "../../lib/agent-resource";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import type { AppVars, Env } from "../env";
import {
	createResource,
	deleteResource,
	getResource,
	listResources,
	updateResource,
} from "../lib/agent-resources";
import { getActiveAccount } from "../lib/db/accounts";
import { publishedFactory } from "../lib/db/factory-runs";
import { ApiError } from "../lib/errors";
import {
	observationEnvelope,
	readObservation,
	requireCatalogRepo,
} from "../lib/machine-observations";
import { readJson } from "../lib/read-body";
import { repoPolicy } from "../lib/repo-statistics";
import { assemblePages, type SnapshotPage } from "../lib/snapshot-pages";

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
		const repository = c.req.query("repository");
		if (repository) await requireCatalogRepo(c.get("db"), account, repository);
		const rows = await c
			.get("db")
			.prepare(
				"SELECT kind,payload FROM snapshots WHERE account_id=? AND kind LIKE 'repo:%' AND (kind LIKE '%:issues' OR kind LIKE '%:issues#2' OR kind LIKE '%:prs' OR kind LIKE '%:prs#2' OR kind LIKE '%:actions' OR kind LIKE '%:actions#2' OR kind LIKE '%:releases' OR kind LIKE '%:releases#2' OR kind LIKE '%:details' OR kind LIKE '%:details#2')",
			)
			.bind(account)
			.all<SnapshotPage>();
		const groups = new Map<string, SnapshotPage[]>();
		for (const row of rows.results) {
			const key = row.kind.replace(/#2$/, "");
			if (repository && !key.startsWith(`repo:${repository}:`)) continue;
			groups.set(key, [...(groups.get(key) ?? []), row]);
		}
		const sources = await Promise.all(
			[...groups].map(async ([resource, pages]) => {
				const envelope = await observationEnvelope(
					account,
					resource,
					assemblePages(resource, pages),
				);
				return {
					resource,
					version: envelope.sourceVersion,
					fetchedAt: envelope.fetchedAt,
					freshness: envelope.freshness,
					coverage: envelope.coverage,
					truncated: envelope.truncated,
					unavailable: envelope.unavailable,
				};
			}),
		);
		for (const resource of ["issues", "prs", "ci", "factory", "repos"]) {
			try {
				const envelope = await readObservation(c.get("db"), account, resource, "all");
				sources.push({
					resource: `account:${resource}`,
					version: envelope.sourceVersion,
					fetchedAt: envelope.fetchedAt,
					freshness: envelope.freshness,
					coverage: envelope.coverage,
					truncated: envelope.truncated,
					unavailable: envelope.unavailable,
				});
			} catch (error) {
				if (!(error instanceof ApiError) || error.code !== "snapshot_missing") throw error;
			}
		}
		const active = await getActiveAccount(c.get("db"));
		const policy = await repoPolicy(c.get("db"), account);
		const repositories = policy.repos
			.filter(
				(repo) =>
					repo.owner_login === active?.login &&
					repo.is_archived !== true &&
					repo.is_fork !== true &&
					repo.name_with_owner.toLowerCase() !== "nocoo/rsshub",
			)
			.map((repo) => repo.name_with_owner)
			.sort();
		const publication = await publishedFactory(c.get("db"), account);
		for (const repo of publication?.repos ?? []) {
			if (repository && repo.name !== repository) continue;
			for (const stream of FACTORY_STREAMS) {
				const coverage = repo.coverage[stream];
				sources.push({
					resource: `factory:${repo.name}:${stream}`,
					version: repo.observation?.version ?? publication?.runId ?? "",
					fetchedAt: coverage.fetchedAt,
					freshness: {
						oldestAt: coverage.fetchedAt,
						latestAt: coverage.fetchedAt,
						total: 1,
						missing: coverage.status === "complete" ? 0 : 1,
					},
					coverage,
					truncated: coverage.status === "limited",
					unavailable:
						coverage.status === "pending" ||
						coverage.status === "partial" ||
						coverage.status === "unavailable",
				});
			}
		}
		return c.json({ account_id: account, sources, repositories });
	});
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
			return c.json(
				{ account_id: account, item: await createResource(db, account, kind, body) },
				201,
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
