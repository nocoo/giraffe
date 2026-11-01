import { z } from "zod";
import { REFRESH_DIMENSIONS, type RefreshDay, type RefreshParams } from "../../lib/refresh-types";
import { ApiError } from "./errors";

const DAY = 86_400_000;
const inputSchema = z
	.object({
		lookbackDays: z.number().int().min(1).max(90).optional(),
		since: z.iso.date().optional(),
		until: z.iso.date().optional(),
		timezone: z.string().min(1).max(100).default("Asia/Shanghai"),
		dimensions: z
			.array(z.enum(REFRESH_DIMENSIONS))
			.min(1)
			.max(REFRESH_DIMENSIONS.length)
			.default([...REFRESH_DIMENSIONS]),
		force: z.boolean().default(false),
		repo: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/)
			.max(250)
			.optional(),
	})
	.strict();

function formatter(timezone: string) {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
}
function dateAt(format: Intl.DateTimeFormat, at: number): string {
	const parts = format.formatToParts(at);
	const part = (type: string) => parts.find((value) => value.type === type)?.value;
	return `${part("year")}-${part("month")}-${part("day")}`;
}
function shift(date: string, days: number) {
	return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}
function midnight(date: string, format: Intl.DateTimeFormat): string {
	const noon = Date.parse(`${date}T12:00:00.000Z`);
	let low = noon - 2 * DAY;
	let high = noon + DAY;
	while (high - low > 1) {
		const middle = Math.floor((low + high) / 2);
		if (dateAt(format, middle) < date) low = middle;
		else high = middle;
	}
	return new Date(high).toISOString();
}
export function parseRefreshParams(value: unknown, now = new Date()): RefreshParams {
	const parsed = inputSchema.safeParse(value);
	if (!parsed.success) throw new ApiError(400, "validation_failed", "invalid refresh parameters");
	const { lookbackDays } = parsed.data;
	if (
		lookbackDays !== undefined &&
		(parsed.data.since !== undefined ||
			parsed.data.until !== undefined ||
			parsed.data.repo !== undefined ||
			parsed.data.timezone !== "Asia/Shanghai")
	)
		throw new ApiError(
			400,
			"validation_failed",
			"lookback requires Shanghai calendar days without since, until or repo",
		);
	let today: string;
	try {
		today = dateAt(formatter(parsed.data.timezone), now.getTime());
	} catch {
		throw new ApiError(400, "validation_failed", "invalid display timezone");
	}
	const until = parsed.data.until ?? shift(today, -1);
	const since = parsed.data.since ?? shift(until, 1 - (lookbackDays ?? 1));
	if (
		since > until ||
		until >= today ||
		(lookbackDays === undefined && shift(since, 30) < until) ||
		new Set(parsed.data.dimensions).size !== parsed.data.dimensions.length
	)
		throw new ApiError(
			400,
			"validation_failed",
			"refresh requires 1 to 31 closed calendar days and unique dimensions",
		);
	return {
		timezone: parsed.data.timezone,
		dimensions: parsed.data.dimensions,
		force: parsed.data.force,
		since,
		until,
		...(lookbackDays === undefined ? {} : { lookbackDays }),
		...(parsed.data.repo === undefined ? {} : { repo: parsed.data.repo }),
	};
}
export function refreshDays(params: RefreshParams): RefreshDay[] {
	const format = formatter(params.timezone);
	const days: RefreshDay[] = [];
	for (let date = params.since; date <= params.until; date = shift(date, 1)) {
		days.push({ date, since: midnight(date, format), until: midnight(shift(date, 1), format) });
	}
	return days;
}
export function calendarDayBounds(date: string, timezone: string): RefreshDay {
	const format = formatter(timezone);
	return { date, since: midnight(date, format), until: midnight(shift(date, 1), format) };
}
