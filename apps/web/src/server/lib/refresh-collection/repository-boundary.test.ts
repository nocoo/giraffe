import { describe, expect, it } from "vitest";
import type { RefreshDay } from "../../../lib/refresh-types";
import type { CollectionContext } from "../refresh-collection-contract";
import { observationBoundaryDay } from "./repository";

const day = (date: string): RefreshDay => ({
	date,
	since: `${date}T00:00:00.000Z`,
	until: `${date}T23:59:59.999Z`,
});

const context = (days: RefreshDay[]): CollectionContext =>
	({ days, run: { params: { timezone: "Asia/Shanghai" } } }) as CollectionContext;

describe("observationBoundaryDay", () => {
	it("returns the in-window day containing the oldest observation", () => {
		const days = [day("2026-10-28"), day("2026-10-29")];
		expect(observationBoundaryDay(context(days), "2026-10-28T12:00:00.000Z")).toBe("2026-10-28");
	});

	it("returns the first window day when the oldest observation predates the window", () => {
		const days = [day("2026-10-29")];
		expect(observationBoundaryDay(context(days), "2026-10-28T12:00:00.000Z")).toBe("2026-10-29");
	});

	it("falls back to the last window day or the ISO date prefix", () => {
		const days = [day("2026-10-28"), day("2026-10-29")];
		expect(observationBoundaryDay(context(days), "2026-11-01T12:00:00.000Z")).toBe("2026-10-29");
		expect(observationBoundaryDay(context([]), "2026-11-01T12:00:00.000Z")).toBe("2026-11-01");
	});
});
