import type { FactoryStreamData } from "../../../lib/factory-types";
import type { RefreshDay } from "../../../lib/refresh-types";
import type { DayObservation } from "./model";

const RESOURCE_PAGE_BYTES = 1_500_000;

function retainedStreamItemCount(
	dimension: string,
	retainedDays: RefreshDay[],
	current: Map<string, DayObservation>,
): number {
	if (dimension === "commits" || dimension === "alerts") return 0;
	return retainedDays.reduce((count, day) => {
		const row = current.get(`${day.date}:${dimension}`);
		if (row?.status !== "complete") return count;
		const value = JSON.parse(row.payload) as { items?: unknown[] };
		return count + (Array.isArray(value.items) ? value.items.length : 0);
	}, 0);
}

export function applyResourceStorageLimit(
	resource: FactoryStreamData,
	dimension: string,
	retainedDays: RefreshDay[],
	current: Map<string, DayObservation>,
): FactoryStreamData {
	const retainedItems = retainedStreamItemCount(dimension, retainedDays, current);
	if (retainedItems <= resource.items.length) return resource;
	const sample = JSON.stringify({ items: resource.items, coverage: resource.coverage, ranges: [] });
	const bytesPerItem =
		resource.items.length > 0
			? Math.ceil(new TextEncoder().encode(sample).length / resource.items.length)
			: 0;
	if (bytesPerItem * retainedItems <= RESOURCE_PAGE_BYTES) return resource;
	return {
		...resource,
		ranges: [],
		coverage: {
			...resource.coverage,
			status: "limited",
			reason: "storage_limit",
			completeWindows: [],
			availableWindows: [],
			inventoryComplete: false,
		},
	};
}
