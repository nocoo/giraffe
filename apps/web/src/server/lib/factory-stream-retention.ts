import { emptyDay } from "../../lib/factory";
import type {
	FactoryDay,
	FactoryMetrics,
	FactoryRepo,
	FactoryStreamData,
	FactoryStreamName,
} from "../../lib/factory-types";
import { storedContent } from "./content-version";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { readSnapshot } from "./db/snapshots";
import { streamKey } from "./factory-collect";

function missingEvidence(repo: FactoryRepo, stream: FactoryStreamName): D1PreparedStatement[] {
	repo.coverage[stream] = {
		...repo.coverage[stream],
		status: "unavailable",
		reason_code: "unknown",
		reason: "Retained stream evidence is missing or mismatched",
	};
	return [];
}

const metrics: Record<FactoryStreamName, (keyof FactoryMetrics)[]> = {
	commits: ["commits", "authors"],
	issues: ["issueOpened", "issueClosed", "agedIssues"],
	prs: ["prOpened", "prMerged", "prClosed", "agedPrs", "botOpen", "botMerged", "cycleHours"],
	actions: ["ciSuccess", "ciFailure", "ciOther", "ciPending"],
	releases: ["releases"],
	alerts: ["alerts"],
	dependencies: [],
};

export async function retainFactoryStream(
	db: Db,
	lease: RunLease,
	now: string,
	repo: FactoryRepo,
	previous: FactoryRepo,
	stream: FactoryStreamName,
): Promise<D1PreparedStatement[]> {
	const coverage = previous.coverage[stream];
	const observation = coverage.observation ?? previous.observation;
	repo.coverage[stream] = {
		...coverage,
		retained: true,
		...(observation
			? {
					observation: {
						...observation,
						head: coverage.observation ? coverage.observation.head : previous.head,
					},
				}
			: {}),
	};
	for (const key of metrics[stream])
		Object.assign(repo.metrics, { [key]: structuredClone(previous.metrics[key]) });
	const dayKeys = metrics[stream].filter((key): key is keyof FactoryDay => key in emptyDay());
	for (const date of new Set([
		...Object.keys(repo.metrics.days),
		...Object.keys(previous.metrics.days),
	])) {
		const day = repo.metrics.days[date] ?? emptyDay();
		for (const key of dayKeys) day[key] = previous.metrics.days[date]?.[key] ?? 0;
		if (Object.values(day).some((value) => value !== 0)) repo.metrics.days[date] = day;
		else delete repo.metrics.days[date];
	}
	if (stream === "dependencies") {
		repo.dependencies = structuredClone(previous.dependencies);
		if (previous.manifests) repo.manifests = structuredClone(previous.manifests);
		else delete repo.manifests;
	}
	if (!previous.observation || !repo.observation || !observation)
		return missingEvidence(repo, stream);
	const original = previous.observation.repo ?? previous.name;
	let data: FactoryStreamData | null;
	let metadata: string | null;
	if (previous.observation.source === "run") {
		const row = await db
			.prepare(
				"SELECT payload,content_meta FROM factory_resources WHERE run_id=? AND repo=? AND stream=?",
			)
			.bind(
				previous.observation.version,
				original,
				coverage.observation ? `retained:${stream}` : stream,
			)
			.first<{ payload: string; content_meta: string | null }>();
		data = row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
		metadata = row?.content_meta ?? null;
	} else {
		data = (await readSnapshot(
			db,
			lease.run.account_id,
			streamKey(original, stream),
		)) as FactoryStreamData | null;
		const saved = storedContent(data);
		metadata = saved ? JSON.stringify(saved) : null;
	}
	if (!data || data.runId !== observation.version) return missingEvidence(repo, stream);
	return [
		fenced(
			db,
			lease,
			now,
			"INSERT INTO factory_resources(run_id,repo,stream,payload,content_meta) SELECT ?,?,?,?,? WHERE $guard ON CONFLICT(run_id,repo,stream) DO NOTHING",
			[repo.observation.version, repo.name, `retained:${stream}`, JSON.stringify(data), metadata],
		),
	];
}
