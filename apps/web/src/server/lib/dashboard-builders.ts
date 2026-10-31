import { readActivity } from "./activity-store";
import type { Db } from "./db/d1";
import { snapshotFromRows } from "./db/snapshots";
import { ApiError } from "./errors";
import { factoryRateFromRow, factoryRateStatement, type SavedFactoryRateRow } from "./factory-rate";
import { projectCiObservation, readMachineAccountObservation } from "./machine-observations";
import { enrichRepoAgentStates } from "./repo-agent-state";
import { enrichRepoMeta } from "./repo-meta";
import {
	accountReadPlan,
	decodePublication,
	type PublicationPage,
	savedAccountPolicy,
} from "./saved-observation-read";
import {
	type AccountObservationResource,
	publicationSnapshotStatement,
} from "./saved-observation-statements";
import { assembleSnapshotGroups, latestSnapshotGroups } from "./snapshot-pages";
import { factoryFreshness, projectFactory, projectSnapshot } from "./snapshot-projection";
import type { SnapshotScope } from "./snapshot-scope";

function missing(status: number, code: string, message: string): never {
	throw new ApiError(status, code, message);
}

async function publishedFactoryRate(db: Db, account: string) {
	const rows = await publicationSnapshotStatement(db, account).all<{ payload: string }>();
	if (!rows.results[0]?.payload) return null;
	try {
		return (
			JSON.parse(rows.results[0].payload) as { rate?: Parameters<typeof factoryRateFromRow>[1] }
		).rate;
	} catch {
		return null;
	}
}

function withFactoryRate<T extends Record<string, unknown>>(body: T, rate: unknown): T {
	if (!("requests" in body)) return { ...body, rate } as T;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		next[key] = value;
		if (key === "requests") next.rate = rate;
	}
	return next as T;
}

function withoutFactoryRate<T extends Record<string, unknown>>(body: T): T {
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (key === "rate") continue;
		next[key] = value;
	}
	return next as T;
}

export async function patchBrowserFactoryBody(
	db: Db,
	account: string,
	stored: Record<string, unknown>,
) {
	const row = await factoryRateStatement(db, account).first<SavedFactoryRateRow>();
	return withFactoryRate(
		stored,
		factoryRateFromRow(row, (await publishedFactoryRate(db, account)) ?? null),
	);
}

export async function patchMachineFactoryObservation(
	db: Db,
	account: string,
	stored: { data: Record<string, unknown> } & Record<string, unknown>,
) {
	const row = await factoryRateStatement(db, account).first<SavedFactoryRateRow>();
	return {
		...stored,
		data: {
			...stored.data,
			rate: factoryRateFromRow(row, (await publishedFactoryRate(db, account)) ?? null),
		},
	};
}

export async function buildBrowserFactory(db: Db, scope: SnapshotScope) {
	const plan = accountReadPlan(db, null, "factory", scope, { rate: true });
	const saved = plan.decode(await db.batch(plan.statements));
	const account = saved.account;
	if (!account) missing(409, "account_missing", "no active account");
	const policy = savedAccountPolicy(saved, scope);
	const snap = decodePublication(saved.sourcePages as PublicationPage[]);
	if (!snap) missing(409, "snapshot_missing", "no factory snapshot");
	const projected = projectFactory(snap, policy);
	const freshness = factoryFreshness(projected, policy);
	const body = withFactoryRate(
		{
			...projected,
			fetched_at: freshness.latestAt ?? "",
			freshness,
			truncated:
				projected.truncated === true ||
				projected.inventory.complete !== true ||
				freshness.missing > 0,
			account_id: account.id,
		},
		factoryRateFromRow(saved.rateRows[0] ?? null, snap.rate),
	);
	return {
		response: body,
		stored: withoutFactoryRate(body),
	};
}

export async function buildBrowserCi(db: Db, scope: SnapshotScope) {
	const plan = accountReadPlan(db, null, "ci", scope);
	const saved = plan.decode(await db.batch(plan.statements));
	const account = saved.account;
	if (!account) missing(409, "account_missing", "no active account");
	const policy = savedAccountPolicy(saved, scope);
	const body = {
		...projectCiObservation(policy, latestSnapshotGroups(saved.ciPages)),
		account_id: account.id,
	};
	return { response: body, stored: body };
}

export async function buildBrowserAccountSnapshot(
	db: Db,
	logical: "repos" | "issues" | "prs",
	scope: SnapshotScope,
	includeRemoved: boolean,
) {
	const plan = accountReadPlan(db, null, logical, scope);
	const saved = plan.decode(await db.batch(plan.statements));
	if (!saved.account) missing(409, "account_missing", "no active account");
	let snap = snapshotFromRows(logical, saved.sourcePages);
	if (!snap && scope === "all") missing(409, "snapshot_missing", `no snapshot for ${logical}`);
	let policy =
		logical === "repos"
			? savedAccountPolicy(saved, scope, snap, includeRemoved)
			: savedAccountPolicy(saved, scope);
	if (!snap && policy.empty) {
		const key = { repos: "repos", issues: "issues", prs: "pull_requests" }[logical];
		snap = { [key]: [], fetched_at: "", truncated: false };
		if (logical === "repos") policy = { ...policy, catalog: snap };
	}
	if (!snap) missing(409, "snapshot_missing", `no snapshot for ${logical}`);
	const projected = await projectSnapshot(db, saved.account.id, logical, snap, policy, () =>
		assembleSnapshotGroups(saved.repositoryPages),
	);
	const body = {
		...projected,
		account_id: saved.account.id,
	};
	return { response: body, stored: body };
}

export async function buildBrowserActivity(
	db: Db,
	accountId: string,
	query: Record<string, string[]>,
) {
	const body = await readActivity(db, accountId, query);
	return { response: body, stored: body };
}

export async function patchBrowserReposBody(
	db: Db,
	accountId: string,
	stored: Record<string, unknown>,
) {
	let data = await enrichRepoAgentStates(db, accountId, stored);
	data = await enrichRepoMeta(db, accountId, data);
	return data;
}

export async function patchMachineReposObservation(
	db: Db,
	accountId: string,
	stored: { data: Record<string, unknown> } & Record<string, unknown>,
) {
	const enriched = await patchBrowserReposBody(db, accountId, stored.data);
	return { ...stored, data: enriched };
}

export async function buildMachineAccountObservation(
	db: Db,
	accountId: string,
	resource: AccountObservationResource,
	scope: SnapshotScope,
	includeRemoved: boolean,
) {
	const observation = await readMachineAccountObservation(
		db,
		accountId,
		resource,
		scope,
		includeRemoved,
	);
	if (resource === "repos") {
		return { response: observation, stored: observation };
	}
	if (resource !== "factory") return { response: observation, stored: observation };
	const stored = structuredClone(observation) as typeof observation;
	delete (stored.data as Record<string, unknown>).rate;
	return { response: observation, stored };
}
