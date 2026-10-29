import type { FactorySnapshot } from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import { accountBindings, accountIdSql, type SavedAccount } from "./saved-observation-statements";

type Rate = FactorySnapshot["rate"];

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
		.prepare(
			`SELECT CASE WHEN json_valid(payload,2) AND json_type(payload,'$.rate')='object' THEN json_extract(payload,'$.rate') END AS rate,NOT json_valid(payload,2) AS malformed FROM refresh_publications WHERE account_id=${accountIdSql(account)}`,
		)
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
