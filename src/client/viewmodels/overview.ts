/** Shared aggregations for list pages: age, category ranking and time series from one snapshot. */
const DAY_MS = 86_400_000;

const utcMidnight = (t: number) =>
	Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());

export function daysAgo(at: string | null | undefined, now: string): number | null {
	const t = Date.parse(at ?? "");
	const end = Date.parse(now);
	if (!Number.isFinite(t) || !Number.isFinite(end)) return null;
	return Math.max(0, Math.round((utcMidnight(end) - utcMidnight(t)) / DAY_MS));
}

export const AGE_BUCKETS = [
	{ key: "d1", label: "今天", max: 0 },
	{ key: "d7", label: "7 天", max: 7 },
	{ key: "d30", label: "30 天", max: 30 },
	{ key: "d90", label: "90 天", max: 90 },
	{ key: "old", label: "更久", max: Number.POSITIVE_INFINITY },
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number]["key"];

export function ageBucket(days: number): AgeBucket {
	// The last bucket's max is Infinity, so find always succeeds.
	return (AGE_BUCKETS.find((b) => days <= b.max) as (typeof AGE_BUCKETS)[number]).key;
}

export function ageBuckets(dates: (string | null | undefined)[], now: string) {
	const counts = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0])) as Record<
		AgeBucket,
		number
	>;
	let unknown = 0;
	for (const at of dates) {
		const days = daysAgo(at, now);
		if (days === null) unknown++;
		else counts[ageBucket(days)]++;
	}
	const rows = AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: counts[b.key] }));
	return { rows, unknown, max: Math.max(1, ...rows.map((r) => r.count)) };
}

export type Ranked = { name: string; value: number; share: number; other?: number };
/** Top categories by count; the rest fold into one "其他" row so colors never cycle. */
export function countBy<T>(rows: T[], key: (row: T) => string, limit = Number.POSITIVE_INFINITY) {
	const counts = new Map<string, number>();
	for (const row of rows) {
		const k = key(row) || "未标记";
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const total = rows.length;
	const head: Ranked[] = sorted
		.slice(0, limit)
		.map(([name, value]) => ({ name, value, share: value / total }));
	const tail = sorted.slice(limit);
	if (tail.length) {
		const value = tail.reduce((n, [, v]) => n + v, 0);
		head.push({ name: "其他", value, share: value / total, other: tail.length });
	}
	return { rows: head, total, max: Math.max(1, ...head.map((r) => r.value)) };
}

/** Last `days` UTC days ending on the snapshot day, optionally split into one column per category. */
export function dailySeries<T>(
	rows: T[],
	at: (row: T) => string,
	now: string,
	days: number,
	split?: (row: T) => string,
) {
	const end = utcMidnight(Date.parse(now));
	const start = end - (days - 1) * DAY_MS;
	const keys = split ? [...new Set(rows.map(split))].sort() : [];
	const points = Array.from({ length: days }, (_, i) => ({
		x: new Date(start + i * DAY_MS).toISOString().slice(0, 10),
		total: 0,
		...Object.fromEntries(keys.map((k) => [k, 0])),
	})) as ({ x: string; total: number } & Record<string, number | string>)[];
	let outside = 0;
	for (const row of rows) {
		const t = Date.parse(at(row));
		const i = Number.isFinite(t) ? Math.round((utcMidnight(t) - start) / DAY_MS) : -1;
		const point = points[i];
		if (i < 0 || !point) {
			outside++;
			continue;
		}
		point.total += 1;
		if (split) point[split(row)] = (point[split(row)] as number) + 1;
	}
	return { points, keys, outside };
}

const monday = (t: number) => {
	const d = new Date(utcMidnight(t));
	return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS;
};
export function weeklySeries<T>(rows: T[], at: (row: T) => string, now: string, weeks: number) {
	const end = Date.parse(now);
	if (!Number.isFinite(end)) return [];
	const last = monday(end);
	const points = Array.from({ length: weeks }, (_, i) => {
		const t = last - (weeks - 1 - i) * 7 * DAY_MS;
		return { t, x: new Date(t).toISOString().slice(5, 10), y: 0 };
	});
	for (const row of rows) {
		const t = Date.parse(at(row));
		const point = Number.isFinite(t) ? points.find((p) => p.t === monday(t)) : undefined;
		if (point) point.y++;
	}
	return points.map(({ x, y }) => ({ x, y }));
}

export function matchesFilters<T>(
	row: T,
	get: Record<string, (row: T) => string | string[]>,
	filters: Record<string, string>,
): boolean {
	return Object.entries(filters).every(([key, want]) => {
		if (!want) return true;
		const value = get[key]?.(row);
		return Array.isArray(value) ? value.includes(want) : value === want;
	});
}

export const shortRepo = (name: string) => name.slice(name.lastIndexOf("/") + 1);
