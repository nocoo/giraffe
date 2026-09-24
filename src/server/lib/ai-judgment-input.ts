import type { ReviewEvidence, ReviewInput } from "../../lib/ai-review";
import { FACTORY_STREAMS, type FactoryStreamName } from "../../lib/factory-types";
import { ApiError } from "./errors";

const STATE_BYTES = 24_000;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const DAY_COLUMNS = [
	"commits",
	"issueOpened",
	"issueClosed",
	"prOpened",
	"prMerged",
	"prClosed",
	"ciSuccess",
	"ciFailure",
	"releases",
] as const;
function evidence(item: ReviewEvidence) {
	const { url: _url, title, body, ...fields } = item;
	return {
		...fields,
		title: title.slice(0, 160),
		...(body ? { body: body.slice(0, 400) } : {}),
		excerpted: title.length > 160 || (body?.length ?? 0) > 400,
	};
}

export function judgmentInput(input: ReviewInput) {
	const state = {
		repository: {
			name: input.repository.name,
			owner: input.repository.owner,
			description: input.repository.description?.slice(0, 400) ?? null,
			descriptionExcerpted: (input.repository.description?.length ?? 0) > 400,
			language: input.repository.language,
			archived: input.repository.archived,
			fork: input.repository.fork,
		},
		version: input.version,
		window: input.window,
		sampledAt: input.sampledAt,
		metrics: {
			...Object.fromEntries(
				Object.entries(input.metrics).filter(([, value]) => typeof value === "number"),
			),
			days: {
				columns: ["date", ...DAY_COLUMNS],
				rows: Object.entries(input.metrics.days).map(([date, day]) => [
					date,
					...DAY_COLUMNS.map((column) => day[column]),
				]),
			},
		},
		coverage: input.coverage,
		events: Object.fromEntries(
			FACTORY_STREAMS.map((stream) => [stream, input.events[stream].map(evidence)]),
		) as Record<FactoryStreamName, ReturnType<typeof evidence>[]>,
		omitted: { ...input.omitted },
	};
	// A UTF-8 byte budget leaves room below Jev's 32k state-plus-question token limit.
	while (bytes(state) > STATE_BYTES) {
		const stream = FACTORY_STREAMS.filter((name) => state.events[name].length).sort(
			(a, b) => bytes(state.events[b]) - bytes(state.events[a]),
		)[0];
		if (!stream)
			throw new ApiError(422, "ai_input_too_large", "The judgment input exceeds its size budget.");
		state.events[stream].pop();
		state.omitted[stream]++;
	}
	return state;
}
