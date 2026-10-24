import { emptyDay, factoryWindow } from "../../lib/factory";
import {
	FACTORY_STREAMS,
	type FactoryDay,
	type FactoryRepo,
	type FactorySnapshot,
	type FactoryWindow,
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

function completeWindows(windows: FactoryWindow[]): FactoryWindow[] {
	const result: FactoryWindow[] = [];
	for (const window of windows
		.filter((value) => value.since < value.until)
		.sort((a, b) => a.since.localeCompare(b.since))) {
		const last = result.at(-1);
		if (last && last.until >= window.since)
			last.until = last.until > window.until ? last.until : window.until;
		else result.push({ ...window });
	}
	return result;
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
	for (const stream of FACTORY_STREAMS) {
		const coverage = repo.coverage[stream];
		if (display.since === window.since) {
			delete coverage.completeWindows;
			continue;
		}
		const old = previous?.coverage[stream];
		const oldWindow = old?.observation?.window ?? previous?.observation?.window;
		const known =
			old?.completeWindows ?? (old?.status === "complete" && oldWindow ? [oldWindow] : []);
		coverage.completeWindows = completeWindows([
			...known.map((value) => ({
				since: value.since < display.since ? display.since : value.since,
				until: value.until > window.since ? window.since : value.until,
			})),
			...(coverage.status === "complete" ? [window] : []),
		]);
	}
	if (display.since !== window.since) repo.observation.collectionWindow = window;
	else delete repo.observation.collectionWindow;
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
	const stamp = (
		day: NonNullable<FactorySnapshot["contribution"]>["days"][number],
		source: NonNullable<FactorySnapshot["contribution"]>,
	) => ({
		...day,
		fetchedAt: day.fetchedAt ?? source.fetchedAt,
		observedAt: day.observedAt ?? source.observedAt ?? source.fetchedAt,
	});
	const days = [
		...older.map((day) => stamp(day, previous as NonNullable<typeof previous>)),
		...fresh.days.filter((day) => within(day.date, window)).map((day) => stamp(day, fresh)),
	].sort((a, b) => a.date.localeCompare(b.date));
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
