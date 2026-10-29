import type { FactoryWindow } from "../../../lib/factory-types";

const at = (value: string) => Date.parse(value);

export function mergeWindows(windows: FactoryWindow[]): FactoryWindow[] {
	const merged: FactoryWindow[] = [];
	for (const window of [...windows].sort((left, right) => at(left.since) - at(right.since))) {
		const last = merged.at(-1);
		if (last && last.timezone === window.timezone && at(window.since) - at(last.until) <= 1) {
			merged[merged.length - 1] = {
				...last,
				until: at(window.until) > at(last.until) ? window.until : last.until,
			};
			continue;
		}
		merged.push({ ...window });
	}
	return merged;
}
