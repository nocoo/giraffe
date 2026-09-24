import type { ReviewInput } from "../../lib/ai-review";
import { emptyDay, inWindow, summarizeEvents } from "../../lib/factory";
import {
	FACTORY_STREAMS,
	type FactoryDay,
	type FactoryEvent,
	type FactoryRepo,
	type FactoryStreamData,
	type FactoryStreamName,
} from "../../lib/factory-types";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

const latestActivity = (item: FactoryEvent) =>
	[item.at, item.createdAt, item.closedAt, item.mergedAt]
		.filter((at) => at !== null)
		.sort()
		.at(-1) ?? "";

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
	const excluded = {} as ReviewInput["excluded"];
	const period = (until: string) => ({
		window: {
			since: new Date(
				Math.max(Date.parse(observation.window.since), Date.parse(until) - 14 * 86400000),
			).toISOString(),
			until,
		},
		activity: emptyDay(),
	});
	const recent = period(observation.window.until);
	const focus = { recent, previous: period(recent.window.since) };
	const coverage = structuredClone(repo.coverage);
	for (const stream of FACTORY_STREAMS) {
		const row = resources.results.find((item) => item.stream === stream);
		const resource = row ? (JSON.parse(row.payload) as FactoryStreamData) : null;
		const items = resource?.runId === version ? resource.items : [];
		for (const { window, activity } of Object.values(focus)) {
			const metrics = summarizeEvents(stream, items, window);
			for (const key of Object.keys(activity) as (keyof FactoryDay)[])
				activity[key] += metrics[key];
		}
		const relevant = items.filter(
			(item) =>
				stream === "dependencies" ||
				(["issues", "prs", "alerts"].includes(stream) && item.state === "open") ||
				[item.at, item.createdAt, item.closedAt, item.mergedAt].some((at) =>
					inWindow(at, recent.window),
				),
		);
		const sorted = relevant.sort(
			(a, b) =>
				Number(b.state === "open") - Number(a.state === "open") ||
				latestActivity(b).localeCompare(latestActivity(a)),
		);
		events[stream] = sorted.slice(0, 24).map((item) => ({
			...item,
			id: `${stream}:${item.id}`,
			excerpted: item.title.length >= 240 || (item.body?.length ?? 0) >= 1200,
			title: item.title.slice(0, 240),
			...(item.body ? { body: item.body.slice(0, 1200) } : {}),
		}));
		omitted[stream] = Math.max(0, relevant.length - events[stream].length);
		excluded[stream] = items.length - relevant.length;
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
		focus,
		coverage,
		events,
		omitted,
		excluded,
	};
}
