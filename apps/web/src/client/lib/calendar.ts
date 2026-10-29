import type { FactoryWindow } from "../../lib/factory-types";
import { formatDate } from "./format";

export function calendarBounds(window: FactoryWindow): { since: number; until: number } {
	if (!window.timezone) {
		return { since: Date.parse(window.since), until: Date.parse(window.until) };
	}
	return {
		since: Date.parse(formatDate(window.since, window.timezone).slice(0, 10)),
		until: Date.parse(formatDate(window.until, window.timezone).slice(0, 10)) + 86_400_000,
	};
}
