import { emptyDay, factoryWindow } from "../../lib/factory";
import type {
	FactoryDay,
	FactoryRepo,
	FactorySnapshot,
	FactoryWindow,
} from "../../lib/factory-types";

export function publishedWindow(
	window: FactoryWindow,
	previous: FactoryWindow[] = [],
): FactoryWindow {
	return {
		since: new Date(
			Math.min(Date.parse(window.since), ...previous.map((value) => Date.parse(value.since))),
		).toISOString(),
		until: window.until,
	};
}

function historyWindow(
	window: FactoryWindow,
	previous: FactoryWindow | undefined,
	dates: string[],
): FactoryWindow {
	const union = publishedWindow(window, [
		...(previous ? [previous] : []),
		...dates
			.filter((date) => date < window.since.slice(0, 10))
			.map((date) => ({ since: `${date}T00:00:00.000Z`, until: window.until })),
	]);
	return {
		since: new Date(
			Math.max(Date.parse(union.since), Date.parse(factoryWindow(window.until).since)),
		).toISOString(),
		until: window.until,
	};
}

function within(date: string, window: FactoryWindow): boolean {
	const time = Date.parse(`${date}T00:00:00.000Z`);
	return time >= Date.parse(window.since) && time < Date.parse(window.until);
}

export function retainRepositoryDays(
	repo: FactoryRepo,
	previous: FactoryRepo | null,
	window: FactoryWindow,
) {
	if (!repo.observation) return;
	if (previous?.id !== repo.id) previous = null;
	const display = historyWindow(
		window,
		previous?.observation?.window,
		Object.keys(previous?.metrics.days ?? {}),
	);
	const older = Object.entries(previous?.metrics.days ?? {}).filter(
		([date]) => within(date, display) && date < window.since.slice(0, 10),
	);
	const removed = Object.entries(repo.metrics.days).filter(([date]) => !within(date, window));
	repo.metrics.days = Object.fromEntries([
		...older.map(([date, day]) => [date, structuredClone(day)] as const),
		...Object.entries(repo.metrics.days).filter(([date]) => within(date, window)),
	]);
	for (const key of Object.keys(emptyDay()) as (keyof FactoryDay)[])
		repo.metrics[key] +=
			older.reduce((sum, [, day]) => sum + day[key], 0) -
			removed.reduce((sum, [, day]) => sum + day[key], 0);
	repo.observation.window = display;
}

export function retainContributionDays(
	fresh: NonNullable<FactorySnapshot["contribution"]>,
	base: FactorySnapshot | null,
	window: FactoryWindow,
) {
	const previous = base?.contribution;
	const display = historyWindow(
		window,
		previous ? (base.contributionObservation?.window ?? base.window) : undefined,
		previous?.days.map((day) => day.date) ?? [],
	);
	const older =
		previous?.days.filter(
			(day) => within(day.date, display) && day.date < window.since.slice(0, 10),
		) ?? [];
	const days = [...older, ...fresh.days.filter((day) => within(day.date, window))].sort((a, b) =>
		a.date.localeCompare(b.date),
	);
	const restricted = older.reduce<number | null>((sum, day) => {
		const count = day.types?.restricted ?? (previous?.restricted === 0 ? 0 : null);
		return sum === null || count === null ? null : sum + count;
	}, fresh.restricted);
	return {
		window: display,
		contribution: {
			...fresh,
			days,
			total: days.reduce((sum, day) => sum + day.count, 0),
			restricted,
			...(fresh.typesStatus
				? {
						typesStatus: days.every((day) => day.breakdown === "complete")
							? ("complete" as const)
							: ("partial" as const),
					}
				: {}),
		},
	};
}
