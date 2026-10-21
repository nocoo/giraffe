import type { FactorySnapshot } from "../../lib/factory-types";
import type { Db } from "./db/d1";

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

export async function readFactoryRate(db: Db, account: string, published: Rate, now = Date.now()) {
	const row = await db
		.prepare(
			"SELECT json_extract(payload,'$.checkpoint.rate') AS rate FROM factory_runs WHERE account_id=? AND json_type(payload,'$.checkpoint.rate')='object' ORDER BY julianday(json_extract(payload,'$.checkpoint.rate.observedAt')) DESC,updated_at DESC,id DESC LIMIT 1",
		)
		.bind(account)
		.first<{ rate: string }>();
	const rate = latestFactoryRate(published, row ? (JSON.parse(row.rate) as Rate) : null);
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
