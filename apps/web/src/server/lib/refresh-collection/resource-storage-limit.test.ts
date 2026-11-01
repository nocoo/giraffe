import { describe, expect, it } from "vitest";
import type { FactoryStreamData } from "../../../lib/factory-types";
import type { DayObservation } from "./model";
import { applyResourceStorageLimit } from "./resource-storage-limit";

const day = {
	date: "2026-10-28",
	since: "2026-10-27T16:00:00.000Z",
	until: "2026-10-28T16:00:00.000Z",
};

const baseResource = (): FactoryStreamData => ({
	runId: "run",
	items: [],
	next: null,
	ranges: [],
	coverage: {
		status: "complete",
		reason: null,
		completeWindows: [],
		pages: 1,
		fetchedAt: "2026-10-29T04:00:00.000Z",
		source: "github",
		observed: 1,
	},
});

describe("applyResourceStorageLimit", () => {
	it("leaves small retained streams unchanged", () => {
		const resource: FactoryStreamData = {
			...baseResource(),
			items: [{ id: "1" } as never],
			ranges: [{ since: day.since, until: day.until, timezone: "Asia/Shanghai" }],
		};
		const current = new Map<string, DayObservation>([
			[
				`${day.date}:actions`,
				{
					day: day.date,
					dimension: "actions",
					status: "complete",
					payload: JSON.stringify({ items: [{ id: "1" }], since: day.since, until: day.until }),
					fetched_at: "2026-10-29T04:00:00.000Z",
				},
			],
		]);
		expect(applyResourceStorageLimit(resource, "actions", [day], current)).toBe(resource);
	});

	it("marks oversized retained action streams as storage limited", () => {
		const items = Array.from({ length: 50 }, (_, index) => ({
			id: `${index}`,
			title: "x".repeat(40_000),
		}));
		const resource: FactoryStreamData = {
			...baseResource(),
			items: items.slice(0, 1) as never[],
			ranges: [{ since: day.since, until: day.until, timezone: "Asia/Shanghai" }],
			coverage: {
				...baseResource().coverage,
				availableWindows: [],
				inventoryComplete: true,
			},
		};
		const current = new Map<string, DayObservation>([
			[
				`${day.date}:actions`,
				{
					day: day.date,
					dimension: "actions",
					status: "complete",
					payload: JSON.stringify({ items, since: day.since, until: day.until }),
					fetched_at: "2026-10-29T04:00:00.000Z",
				},
			],
		]);
		expect(applyResourceStorageLimit(resource, "actions", [day], current)).toMatchObject({
			ranges: [],
			coverage: {
				status: "limited",
				reason: "storage_limit",
				completeWindows: [],
				availableWindows: [],
				inventoryComplete: false,
			},
		});
	});

	it("ignores commit-only dimensions", () => {
		const resource = baseResource();
		expect(applyResourceStorageLimit(resource, "commits", [day], new Map())).toBe(resource);
	});

	it("keeps coverage when retained items fit within the page budget", () => {
		const items = [{ id: "1" }, { id: "2" }];
		const resource: FactoryStreamData = {
			...baseResource(),
			items: [items[0] as never],
			ranges: [{ since: day.since, until: day.until, timezone: "Asia/Shanghai" }],
			coverage: {
				...baseResource().coverage,
				availableWindows: [],
				inventoryComplete: true,
			},
		};
		const current = new Map<string, DayObservation>([
			[
				`${day.date}:actions`,
				{
					day: day.date,
					dimension: "actions",
					status: "complete",
					payload: JSON.stringify({ items, since: day.since, until: day.until }),
					fetched_at: "2026-10-29T04:00:00.000Z",
				},
			],
		]);
		expect(applyResourceStorageLimit(resource, "actions", [day], current)).toBe(resource);
	});
});
