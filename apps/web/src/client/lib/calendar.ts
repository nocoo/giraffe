import type { FactoryRepo, FactoryWindow } from "../../lib/factory-types";
import { formatDate } from "./format";

export function factoryCalendarWindows(
	repo: Partial<Pick<FactoryRepo, "coverage" | "observation">>,
	fallback: FactoryWindow,
): FactoryWindow[] {
	const window = repo.observation?.window ?? fallback;
	return [
		window,
		...Object.values(repo.coverage ?? {}).flatMap(
			(coverage) =>
				coverage.completeWindows ?? [
					coverage.observation?.window ?? repo.observation?.collectionWindow ?? window,
				],
		),
	];
}

export function calendarBounds(window: FactoryWindow): { since: number; until: number } {
	if (!window.timezone) {
		return { since: Date.parse(window.since), until: Date.parse(window.until) };
	}
	return {
		since: Date.parse(formatDate(window.since, window.timezone).slice(0, 10)),
		until: Date.parse(formatDate(window.until, window.timezone).slice(0, 10)) + 86_400_000,
	};
}
