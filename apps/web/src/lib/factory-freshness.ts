import { FACTORY_STREAMS, type FactoryRepo } from "./factory-types";
import { type SnapshotFreshness, snapshotFreshness } from "./snapshot-freshness";

export function factoryEvidenceFreshness(repos: (FactoryRepo | undefined)[]): SnapshotFreshness {
	const evidence = repos.map((repo) => {
		if (!repo?.observation || !Number.isFinite(Date.parse(repo.observation.refreshedAt)))
			return snapshotFreshness([null]);
		return snapshotFreshness(
			FACTORY_STREAMS.flatMap((stream) => {
				const coverage = repo.coverage[stream];
				const oldest =
					coverage.fetchedAt ??
					coverage.observation?.refreshedAt ??
					(coverage.retained ? null : repo.observation?.refreshedAt);
				return coverage.sourceFetchedAt ? [oldest, coverage.sourceFetchedAt] : [oldest];
			}),
		);
	});
	return {
		...snapshotFreshness(evidence.flatMap((item) => [item.oldestAt, item.latestAt])),
		total: repos.length,
		missing: evidence.filter((item) => item.missing > 0).length,
	};
}
