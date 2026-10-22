import type { FactoryRate, FactorySnapshot } from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import { accountBindings, accountIdSql, type SavedAccount } from "./saved-observation-statements";

type Rate = FactorySnapshot["rate"];

export function recordFactoryRate(
	snapshot: FactorySnapshot,
	rate: FactoryRate & { resource: "core" | "graphql" },
) {
	if (snapshot.rate?.resource === "core" || snapshot.rate?.resource === "graphql")
		snapshot.rateLimits = { ...snapshot.rateLimits, [snapshot.rate.resource]: snapshot.rate };
	snapshot.rate = rate;
	snapshot.rateLimits = { ...snapshot.rateLimits, [rate.resource]: rate };
}

export function assertFactoryReserve(snapshot: FactorySnapshot, now: string) {
	const rates = {
		...snapshot.rateLimits,
		...(snapshot.rate ? { [snapshot.rate.resource]: snapshot.rate } : {}),
	};
	for (const rate of Object.values(rates))
		if (rate.remaining < 50 && (!rate.resetAt || Date.parse(rate.resetAt) > Date.parse(now)))
			throw new ApiError(503, "github_rate_limited", "GitHub reserve reached", rate.resetAt);
}

export function latestFactoryRate(...observations: (Rate | undefined)[]): Rate {
	let latest: Rate = null;
	for (const rate of observations) {
		const at = Date.parse(rate?.observedAt ?? "");
		if (rate && Number.isFinite(at) && (!latest || at >= Date.parse(latest.observedAt ?? "")))
			latest = rate;
	}
	return latest;
}

export type SavedFactoryRateRow = { rate: string | null; malformed: number };

export function factoryRateStatement(db: Db, account: SavedAccount) {
	return db
		.prepare(`WITH inputs AS MATERIALIZED (
 SELECT id,updated_at,CASE WHEN json_valid(payload,2) THEN payload END AS payload,
 NOT json_valid(payload,2) AS malformed FROM factory_runs WHERE account_id=${accountIdSql(account)}
 ) SELECT (SELECT json_extract(payload,'$.checkpoint.rate') FROM inputs
 WHERE json_type(payload,'$.checkpoint.rate')='object'
 ORDER BY julianday(json_extract(payload,'$.checkpoint.rate.observedAt')) DESC,updated_at DESC,id DESC LIMIT 1) AS rate,
 coalesce((SELECT max(malformed) FROM inputs),0) AS malformed`)
		.bind(...accountBindings(account));
}

export function factoryRateFromRow(
	row: SavedFactoryRateRow | null,
	published: Rate,
	now = Date.now(),
) {
	if (row?.malformed) throw new ApiError(500, "db_error", "d1 error");
	const rate = latestFactoryRate(published, row?.rate ? (JSON.parse(row.rate) as Rate) : null);
	if (
		!rate ||
		!Number.isInteger(rate.remaining) ||
		rate.remaining < 0 ||
		!rate.resource ||
		Date.parse(rate.observedAt ?? "") > now ||
		!Number.isFinite(Date.parse(rate.resetAt ?? "")) ||
		Date.parse(rate.resetAt ?? "") <= now
	)
		return null;
	return rate;
}

export async function readFactoryRate(db: Db, account: string, published: Rate, now = Date.now()) {
	const row = await factoryRateStatement(db, account).first<SavedFactoryRateRow>();
	return factoryRateFromRow(row, published, now);
}
