import type { Context } from "hono";
import { filterFactoryEvents } from "../../lib/factory";
import { dependencyEvidence } from "../../lib/factory-dependencies";
import {
	FACTORY_STREAMS,
	type FactoryStreamData,
	type FactoryStreamName,
} from "../../lib/factory-types";
import type { AppVars, Env } from "../env";
import { catalogFactoryRepo } from "../lib/catalog-read";
import { ApiError, jsonOk } from "../lib/errors";
import { factoryRateFromRow } from "../lib/factory-rate";
import {
	accountReadPlan,
	decodePublication,
	type PublicationPage,
	savedAccountPolicy,
} from "../lib/saved-observation-read";
import {
	decodeFactoryResource,
	factoryStreamPolicy,
	factoryStreamReadPlan,
} from "../lib/saved-repository-read";
import { factoryFreshness, projectFactory } from "../lib/snapshot-projection";
import { snapshotScope } from "../lib/snapshot-scope";
import { repoParts } from "./snapshots";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const PRIVATE = { "cache-control": "private, no-store" };

export async function getFactory(c: Ctx): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const db = c.get("db");
	const plan = accountReadPlan(db, null, "factory", scope, { rate: true });
	const saved = plan.decode(await db.batch(plan.statements));
	const account = saved.account;
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	const policy = savedAccountPolicy(saved, scope);
	const snap = decodePublication(saved.sourcePages as PublicationPage[]);
	if (!snap) throw new ApiError(409, "snapshot_missing", "no factory snapshot");
	const projected = projectFactory(snap, policy);
	const freshness = factoryFreshness(projected, policy);
	return jsonOk(
		{
			...projected,
			rate: factoryRateFromRow(saved.rateRows[0] ?? null, snap.rate),
			fetched_at: freshness.latestAt ?? "",
			freshness,
			truncated:
				projected.truncated === true ||
				projected.inventory.complete !== true ||
				freshness.missing > 0,
			account_id: account.id,
		},
		200,
		PRIVATE,
		c.get("sourceTiming"),
	);
}
export async function getFactoryStream(c: Ctx): Promise<Response> {
	const scope = snapshotScope(c.req.queries("scope"));
	const db = c.get("db");
	const plan = factoryStreamReadPlan(
		db,
		null,
		`${c.req.param("owner") ?? ""}/${c.req.param("name") ?? ""}`,
		c.req.param("stream") ?? "",
		{ policy: true },
	);
	const saved = plan.decode(await db.batch(plan.statements));
	const account = saved.account;
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	const { owner, name } = repoParts(c.req.param("owner") ?? "", c.req.param("name") ?? "");
	const stream = c.req.param("stream") as FactoryStreamName;
	if (!FACTORY_STREAMS.includes(stream))
		throw new ApiError(400, "validation_failed", "unknown stream");
	const page = Number(c.req.query("page") ?? "1");
	if (!Number.isInteger(page) || page < 1 || page > 50)
		throw new ApiError(400, "validation_failed", "invalid page");
	const snap = decodePublication(saved.publicationPages);
	const repo = snap?.repos
		.map((repo) => catalogFactoryRepo(repo, saved.catalogHistory))
		.find((repo) => repo?.name.toLowerCase() === `${owner}/${name}`.toLowerCase());
	if (repo && !factoryStreamPolicy(saved, scope).includes(repo.name))
		throw new ApiError(404, "not_found", "repository outside selected owned catalog");
	if (!repo || !snap) throw new ApiError(404, "not_found", "repository outside factory inventory");
	let resource: FactoryStreamData | null = null;
	const version =
		repo.coverage[stream].observation?.version ?? repo.observation?.version ?? snap.runId;
	if (repo.observation?.source === "run" || repo.coverage[stream].status !== "pending")
		resource = decodeFactoryResource(saved, snap, repo, stream).data;
	if (!resource && repo.coverage[stream].status !== "pending")
		throw new ApiError(409, "snapshot_missing", "referenced resource unavailable");
	if (resource && resource.runId !== version)
		throw new ApiError(409, "snapshot_missing", "resource version unavailable");
	const filter = c.req.query("state") ?? "";
	const day = c.req.query("day") ?? "";
	if (
		(filter && !/^[a-z_]{1,30}$/.test(filter)) ||
		(day &&
			(!/^\d{4}-\d{2}-\d{2}$/.test(day) ||
				!Number.isFinite(Date.parse(day)) ||
				new Date(day).toISOString().slice(0, 10) !== day))
	)
		throw new ApiError(400, "validation_failed", "invalid detail filter");
	const evidence = resource?.items ?? [];
	const items = filterFactoryEvents(
		stream === "dependencies"
			? dependencyEvidence(evidence, [...(repo.manifests ?? []), ...(resource?.manifests ?? [])])
					.items
			: evidence,
		filter,
		day,
	);
	return jsonOk(
		{
			account_id: account.id,
			runId: snap.runId,
			repo: repo.name,
			stream,
			coverage: resource?.coverage ?? repo.coverage[stream],
			page,
			total: items.length,
			items: items.slice((page - 1) * 100, page * 100),
		},
		200,
		PRIVATE,
		c.get("sourceTiming"),
	);
}
