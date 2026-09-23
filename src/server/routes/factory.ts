import type { Context } from "hono";
import { filterFactoryEvents } from "../../lib/factory";
import {
	FACTORY_STREAMS,
	type FactoryStreamData,
	type FactoryStreamName,
} from "../../lib/factory-types";
import type { AppVars, Env } from "../env";
import { getActiveAccount } from "../lib/db/accounts";
import { publishedFactory } from "../lib/db/factory-runs";
import { readSnapshot } from "../lib/db/snapshots";
import { ApiError, jsonOk } from "../lib/errors";
import { streamKey } from "../lib/factory-collect";
import { repoPolicy, statisticsFactory } from "../lib/repo-statistics";
import { repoParts } from "./snapshots";

type Ctx = Context<{ Bindings: Env; Variables: AppVars }>;
const PRIVATE = { "cache-control": "private, no-store" };

async function active(c: Ctx) {
	const account = await getActiveAccount(c.get("db"));
	if (!account) throw new ApiError(409, "account_missing", "no active account");
	return account;
}
export async function getFactory(c: Ctx): Promise<Response> {
	const account = await active(c);
	const snap = await publishedFactory(c.get("db"), account.id);
	if (!snap) throw new ApiError(409, "snapshot_missing", "no factory snapshot");
	return jsonOk(
		{
			...statisticsFactory(snap, await repoPolicy(c.get("db"), account.id)),
			account_id: account.id,
		},
		200,
		PRIVATE,
	);
}
export async function getFactoryStream(c: Ctx): Promise<Response> {
	const account = await active(c);
	const { owner, name } = repoParts(c.req.param("owner") ?? "", c.req.param("name") ?? "");
	const stream = c.req.param("stream") as FactoryStreamName;
	if (!FACTORY_STREAMS.includes(stream))
		throw new ApiError(400, "validation_failed", "unknown stream");
	const page = Number(c.req.query("page") ?? "1");
	if (!Number.isInteger(page) || page < 1 || page > 50)
		throw new ApiError(400, "validation_failed", "invalid page");
	const snap = await publishedFactory(c.get("db"), account.id);
	const repo = snap?.repos.find((r) => r.name === `${owner}/${name}`);
	if (repo && !(await repoPolicy(c.get("db"), account.id)).enabled(repo.name, repo))
		throw new ApiError(404, "not_found", "repository excluded from statistics");
	if (!repo || !snap) throw new ApiError(404, "not_found", "repository outside factory inventory");
	let resource: FactoryStreamData | null = null;
	const version = repo.observation?.version ?? snap.runId;
	const sourceRepo = repo.observation?.repo ?? repo.name;
	if (repo.observation?.source === "run") {
		const row = await c
			.get("db")
			.prepare(
				"SELECT payload FROM factory_resources WHERE run_id=? AND repo=? AND stream=? AND EXISTS(SELECT 1 FROM factory_runs WHERE id=? AND account_id=?)",
			)
			.bind(version, sourceRepo, stream, version, account.id)
			.first<{ payload: string }>();
		resource = row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
	} else if (repo.coverage[stream].status !== "pending")
		resource = (await readSnapshot(
			c.get("db"),
			account.id,
			streamKey(sourceRepo, stream),
		)) as FactoryStreamData | null;
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
	const items = filterFactoryEvents(resource?.items ?? [], filter, day);
	return jsonOk(
		{
			account_id: account.id,
			runId: snap.runId,
			repo: repo.name,
			stream,
			coverage: repo.coverage[stream],
			page,
			total: items.length,
			items: items.slice((page - 1) * 100, page * 100),
		},
		200,
		PRIVATE,
	);
}
