import type { FactorySnapshot } from "../../lib/factory-types";
import { contributionDates } from "./factory-contributions";

type ContributionDay = NonNullable<FactorySnapshot["contribution"]>["days"][number];

const DAY_MS = 86_400_000;

export type RefreshCalendarWindow = { since: string; until: string };
export type RefreshCalendarCoverage = {
	complete: boolean;
	reason:
		| "complete"
		| "missing"
		| "window_invalid"
		| "dates_invalid"
		| "dates_incomplete"
		| "total_invalid";
	window: RefreshCalendarWindow | null;
};
export type RefreshCalendarEvidence = {
	fetchedAt: unknown;
	window: unknown;
	days: unknown;
	total: unknown;
};

function precedingYear(anchor: unknown): RefreshCalendarWindow | null {
	if (typeof anchor !== "string") return null;
	const end = new Date(anchor);
	if (!Number.isFinite(end.getTime())) return null;
	const start = new Date(end);
	start.setUTCFullYear(end.getUTCFullYear() - 1);
	return { since: start.toISOString(), until: end.toISOString() };
}

export function contributionWindow(anchor: string): RefreshCalendarWindow {
	const window = precedingYear(anchor);
	if (!window) throw new RangeError("invalid contribution calendar anchor");
	return window;
}

const claimedWindow = (value: unknown): RefreshCalendarWindow | null => {
	if (!value || typeof value !== "object") return null;
	const { since, until } = value as Record<string, unknown>;
	if (typeof since !== "string" || typeof until !== "string") return null;
	return Number.isFinite(Date.parse(since)) && Number.isFinite(Date.parse(until))
		? { since, until }
		: null;
};
const sameWindow = (left: RefreshCalendarWindow, right: RefreshCalendarWindow) =>
	Date.parse(left.since) === Date.parse(right.since) &&
	Date.parse(left.until) === Date.parse(right.until);
const dateOf = (value: unknown): number | null => {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const ms = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
};
const validCount = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

export function annualCalendarCoverage(evidence: RefreshCalendarEvidence): RefreshCalendarCoverage {
	const window = claimedWindow(evidence.window);
	const canonical = precedingYear(evidence.fetchedAt);
	if (!evidence.fetchedAt || !evidence.window || evidence.days == null || evidence.total == null)
		return { complete: false, reason: "missing", window: null };
	if (!window || !canonical || !sameWindow(window, canonical))
		return { complete: false, reason: "window_invalid", window: canonical };
	const expected = contributionDates(
		canonical.since.slice(0, 10),
		canonical.until.slice(0, 10),
	).map((date) => Date.parse(`${date}T00:00:00.000Z`));
	if (!Array.isArray(evidence.days) || !expected.length)
		return { complete: false, reason: "dates_invalid", window: canonical };
	const seen = new Set<number>();
	let previous: number | null = null;
	for (const day of evidence.days) {
		if (!day || typeof day !== "object")
			return { complete: false, reason: "dates_invalid", window: canonical };
		const record = day as Record<string, unknown>;
		const ms = dateOf(record.date);
		if (ms === null || !validCount(record.count) || seen.has(ms))
			return { complete: false, reason: "dates_invalid", window: canonical };
		if (previous !== null && ms !== previous + DAY_MS)
			return { complete: false, reason: "dates_invalid", window: canonical };
		seen.add(ms);
		previous = ms;
	}
	if (!expected.every((ms) => seen.has(ms)))
		return { complete: false, reason: "dates_incomplete", window: canonical };
	if (!validCount(evidence.total))
		return { complete: false, reason: "total_invalid", window: canonical };
	return { complete: true, reason: "complete", window: canonical };
}

export function savedAnnualCalendarCoverage(
	snapshot: FactorySnapshot | null | undefined,
): RefreshCalendarCoverage {
	return annualCalendarCoverage({
		fetchedAt: snapshot?.fetched_at,
		window: snapshot?.contributionObservation?.window,
		days: snapshot?.contribution?.days,
		total: snapshot?.contribution?.total,
	});
}

export function materializeContributionDays(
	fetchedAt: string,
	window: RefreshCalendarWindow,
	rawDays: Array<{ date: string; count: number }>,
): ContributionDay[] | null {
	if (!rawDays.length) return null;
	const expected = contributionDates(window.since.slice(0, 10), window.until.slice(0, 10));
	if (!expected.length) return null;
	const byDate = new Map(rawDays.map((day) => [day.date, day.count]));
	return expected.map((date) => ({
		date,
		count: byDate.get(date) ?? 0,
		fetchedAt,
		observedAt: fetchedAt,
		breakdown: "unavailable" as const,
	}));
}

export function contributionFailureCode(coverage: RefreshCalendarCoverage): string {
	if (coverage.reason === "complete") return "contributions:unavailable";
	return `contributions:coverage_${coverage.reason}`;
}
