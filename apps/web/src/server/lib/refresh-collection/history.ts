import type { FactoryCoverage, FactoryWindow } from "../../../lib/factory-types";
import type { RefreshDay } from "../../../lib/refresh-types";
import type { CollectionContext } from "../refresh-collection-contract";
import type { Dimension } from "./dimensions";
import { type DayObservation, object, text, unavailable } from "./model";
import { mergeWindows } from "./windows";

export const PUBLICATION_DAYS = 90;

export function publicationDays(context: CollectionContext, rows: DayObservation[]): RefreshDay[] {
	const days = new Map<string, RefreshDay>();
	for (const row of rows) {
		if (days.has(row.day)) continue;
		const payload = JSON.parse(row.payload) as { since: string; until: string };
		days.set(row.day, { date: row.day, since: payload.since, until: payload.until });
	}
	for (const day of context.days) days.set(day.date, day);
	return [...days.values()]
		.sort((first, second) => first.date.localeCompare(second.date))
		.slice(-PUBLICATION_DAYS);
}

export function dayCoverage(
	context: CollectionContext,
	dimension: string,
	days: RefreshDay[],
	current: Map<string, DayObservation>,
	result: Dimension | undefined,
	needed: string[],
): { coverage: FactoryCoverage & { completeWindows: FactoryWindow[] }; settled: boolean } {
	const selected = days.map((day) => current.get(`${day.date}:${dimension}`));
	const stored = selected.filter((row): row is DayObservation => row !== undefined);
	const settled = stored
		.filter((row) => row.status === "complete")
		.map((row) => ({ row, payload: object(JSON.parse(row.payload)) }));
	const available = settled.filter(({ payload }) => payload.unavailable !== true);
	const settledReason =
		settled
			.map(({ payload }) => text(payload.reason))
			.find((reason): reason is string => reason !== null) ?? "unavailable";
	const missing =
		selected.length !== stored.length || stored.some((row) => row.status !== "complete");
	const latest = [...stored].sort((first, second) =>
		second.fetched_at.localeCompare(first.fetched_at),
	)[0];
	const inventoryComplete =
		dimension === "issues" || dimension === "prs"
			? (result?.inventoryComplete ??
				object(JSON.parse(latest?.payload ?? "{}")).inventoryComplete === true)
			: undefined;
	const sources = new Set(
		stored.map((row) => text(object(JSON.parse(row.payload)).source) ?? "unknown"),
	);
	const times = stored
		.filter((row) => row.status !== "unavailable")
		.map((row) => row.fetched_at)
		.filter(Boolean)
		.sort();
	return {
		settled: selected.length > 0 && !missing,
		coverage: {
			...unavailable(dimension),
			...(inventoryComplete === undefined ? {} : { inventoryComplete }),
			source: sources.size > 1 ? "mixed" : ([...sources][0] ?? "unavailable"),
			status:
				available.length === selected.length
					? "complete"
					: available.length || selected.some((row) => row?.status === "partial")
						? "partial"
						: "unavailable",
			pages: result || (dimension === "commits" && needed.includes(dimension)) ? 1 : 0,
			fetchedAt: times[0] ?? null,
			sourceFetchedAt: times.at(-1) ?? null,
			observed: available.length,
			...(dimension === "alerts"
				? {
						availableWindows: mergeWindows(
							available.map(({ payload }) => ({
								since: String(payload.since),
								until: new Date(Date.parse(String(payload.until)) - 1).toISOString(),
								timezone: context.run.params.timezone,
							})),
						),
					}
				: {}),
			reason:
				available.length === selected.length ? null : missing ? "missing_days" : settledReason,
			completeWindows: mergeWindows(
				settled.map(({ payload }) => ({
					since: String(payload.since),
					until: new Date(Date.parse(String(payload.until)) - 1).toISOString(),
					timezone: context.run.params.timezone,
				})),
			),
			strategy: needed.includes(dimension) ? "incremental" : "reused",
		},
	};
}
