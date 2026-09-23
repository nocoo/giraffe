import type { ReviewInput } from "../../lib/ai-review";
import {
	FACTORY_STREAMS,
	type FactoryRepo,
	type FactoryStreamData,
	type FactoryStreamName,
} from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

export async function assessmentInput(
	db: Db,
	account: string,
	name: string,
	version: string,
): Promise<ReviewInput> {
	const stored = await db
		.prepare(
			"SELECT payload FROM factory_repo_versions WHERE account_id=? AND repo=? AND version=?",
		)
		.bind(account, name, version)
		.first<{ payload: string }>();
	if (!stored) throw new ApiError(409, "ai_source_missing", "Assessment source unavailable");
	const repo = JSON.parse(stored.payload) as FactoryRepo;
	const observation = repo.observation;
	if (!observation) throw new ApiError(409, "ai_source_missing", "Assessment source unavailable");
	const resources = await db
		.prepare("SELECT stream,payload FROM factory_resources WHERE run_id=? AND repo=?")
		.bind(version, name)
		.all<{ stream: FactoryStreamName; payload: string }>();
	const events = {} as ReviewInput["events"];
	const omitted = {} as ReviewInput["omitted"];
	const coverage = structuredClone(repo.coverage);
	for (const stream of FACTORY_STREAMS) {
		const row = resources.results.find((item) => item.stream === stream);
		const resource = row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
		const items = resource?.runId === version ? resource.items : [];
		const sorted = [...items].sort(
			(a, b) => Number(b.state === "open") - Number(a.state === "open") || b.at.localeCompare(a.at),
		);
		events[stream] = sorted.slice(0, 24).map((item) => ({
			...item,
			id: `${stream}:${item.id}`,
			title: item.title.slice(0, 240),
			...(item.body ? { body: item.body.slice(0, 1200) } : {}),
		}));
		omitted[stream] = Math.max(0, items.length - events[stream].length);
		if (!resource || resource.runId !== version)
			coverage[stream] = {
				...coverage[stream],
				status: "unavailable",
				reason: "assessment_source_missing",
			};
	}
	return {
		repository: {
			id: repo.id,
			name: repo.name,
			url: repo.url,
			owner: repo.name.split("/")[0] ?? "",
			description: repo.description,
			language: repo.language,
			archived: repo.is_archived === true,
			fork: repo.is_fork === true,
		},
		version,
		window: observation.window,
		sampledAt: observation.refreshedAt,
		metrics: repo.metrics,
		coverage,
		events,
		omitted,
	};
}
