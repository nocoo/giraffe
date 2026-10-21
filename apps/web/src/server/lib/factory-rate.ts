import type { FactoryRate, FactorySnapshot } from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

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
