import { snapshotFreshness } from "../../lib/snapshot-freshness";
import { composeContent, storedContent } from "./content-version";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import { contributionDate, contributionDates, contributionTypes } from "./factory-contributions";
import { observationEnvelope } from "./machine-observations";
import { assertMachineQuery } from "./machine-query";
import { savedAccountPublication } from "./refresh-collection/store";
import { decodePublication, type PublicationPage } from "./saved-observation-read";
import { publicationSnapshotStatement } from "./saved-observation-statements";

export async function readContributions(db: Db, account: string, query: Record<string, string[]>) {
	assertMachineQuery(
		Object.fromEntries(Object.entries(query).map(([key, values]) => [key, values[0] ?? ""])),
		["since", "until"],
	);
	if (
		Object.values(query).some(
			(values) => values.length !== 1 || !contributionDate.safeParse(values[0]).success,
		)
	)
		throw new ApiError(400, "validation_failed", "expected one YYYY-MM-DD date per filter");
	if (
		query.since?.[0] &&
		query.until?.[0] &&
		!contributionDates(query.since[0], query.until[0]).length
	)
		throw new ApiError(400, "validation_failed", "invalid contribution date range");
	const snapshot = decodePublication(
		(await publicationSnapshotStatement(db, account).all<PublicationPage>()).results,
	);
	const accountObservation = await savedAccountPublication(db, account);
	const saved = snapshot?.contribution?.days.length
		? snapshot.contribution
		: accountObservation?.contribution?.days.length
			? accountObservation.contribution
			: null;
	const publicationSnapshot =
		snapshot ??
		(accountObservation?.contribution?.days.length
			? { ...accountObservation, repos: accountObservation.repos ?? [] }
			: null);
	if (!publicationSnapshot || !saved?.days.length)
		throw new ApiError(409, "snapshot_missing", "no saved contribution calendar");
	const observed = new Map(
		saved.days
			.filter((day) => contributionDate.safeParse(day.date).success)
			.map((day) => [day.date, day]),
	);
	const dates = [...observed.keys()].sort();
	const first = dates[0];
	const last = dates.at(-1);
	if (!first || !last) throw new ApiError(409, "snapshot_missing", "no saved contribution dates");
	const since = query.since?.[0] ?? first;
	const until = query.until?.[0] ?? last;
	const selected = contributionDates(since, until);
	if (!selected.length || since < first || until > last)
		throw new ApiError(400, "validation_failed", "contribution range exceeds saved dates");
	const provenance =
		publicationSnapshot.contributionObservation ?? accountObservation?.contributionObservation;
	const window = provenance?.window ?? publicationSnapshot.window;
	const observedAt = saved.observedAt ?? saved.fetchedAt;
	const days = selected.map((date) => {
		const day = observed.get(date);
		const valid = day && Number.isSafeInteger(day.count) && day.count >= 0;
		return {
			date,
			count: valid ? day.count : null,
			partial: day?.partial ?? date >= window.until.slice(0, 10),
			observedAt: day?.observedAt ?? observedAt,
			fetchedAt: day?.fetchedAt ?? saved.fetchedAt,
			types: { ...contributionTypes(), ...day?.types },
			breakdown: day?.breakdown ?? "unavailable",
			unavailable: !valid,
		};
	});
	const missing = days.some((day) => day.unavailable);
	const freshness = snapshotFreshness(days.map((day) => (day.unavailable ? null : day.fetchedAt)));
	return observationEnvelope(
		account,
		"contributions",
		{
			since,
			until,
			days,
			total: missing ? null : days.reduce((sum, day) => sum + Number(day.count), 0),
			observedAt: snapshotFreshness(days.map((day) => (day.unavailable ? null : day.observedAt)))
				.latestAt,
			fetched_at: freshness.latestAt,
			freshness,
			coverage: {
				status: missing ? "unavailable" : "complete",
				total: selected.length,
				observed: days.filter((day) => !day.unavailable).length,
				typesStatus: saved.typesStatus ?? "unavailable",
			},
			unavailable: missing,
			partial: days.some((day) => day.partial),
			timezone: "github",
			typeWindowTimezone: "UTC",
			window,
			collectionStatus: publicationSnapshot.contributionStatus,
		},
		"all",
		publicationSnapshot.publication?.runId ?? publicationSnapshot.runId,
		provenance?.version ?? publicationSnapshot.runId,
		await composeContent(
			{ publication: storedContent(publicationSnapshot)?.hash ?? null },
			{ since, until },
		),
	);
}
