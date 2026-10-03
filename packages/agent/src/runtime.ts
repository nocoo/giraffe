import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Registry, type Storage } from "@earendil-works/pi-durable";
import {
	type AnalysisReport,
	analysisReportSchema,
	type Judgment,
	type SpecialistResult,
} from "./contracts.ts";
import type { AnalysisInput } from "./evidence.ts";

export function finalizeReport(
	result: SpecialistResult,
	input: AnalysisInput,
	judgment: Judgment,
	producer: AnalysisReport["producer"],
	now: string,
): AnalysisReport {
	const ids = new Set(input.evidence.map((item) => item.id));
	if (result.findings.some((finding) => finding.evidenceIds.some((id) => !ids.has(id))))
		throw new Error("Report references unknown evidence.");
	const incomplete =
		input.sources.length === 0 ||
		input.sources.some(
			(source) =>
				!source.complete ||
				source.stale ||
				!source.fetchedAt ||
				Date.parse(now) - Date.parse(source.fetchedAt) > 36 * 60 * 60 * 1000,
		);
	const verdict =
		result.verdict === "pass" &&
		(incomplete ||
			input.domain === "cd" ||
			(input.domain === "prs" && (input.counts["prs.total"] ?? 0) > 0))
			? "unknown"
			: result.verdict;
	const report = analysisReportSchema.parse({
		...result,
		verdict,
		schemaVersion: 1,
		scope: input.scope,
		repository: input.repository,
		domain: input.domain,
		sourceVersion: input.sourceVersion,
		observedAt: input.observedAt,
		generatedAt: now,
		sources: input.sources,
		evidence: input.evidence,
		omitted: input.omitted,
		judgment,
		producer,
		limitations: [...new Set([...input.limitations, ...result.limitations])].slice(0, 20),
	});
	if (Buffer.byteLength(JSON.stringify(report)) > 63000)
		throw new Error("Report exceeds the publication size budget. Shorten the analysis.");
	return report;
}

export type AgentRuntime = { harness: Harness; registry: Registry; close(): Promise<void> };
export async function openRuntime(options: {
	storage: Storage;
	models: Models;
}): Promise<AgentRuntime> {
	const registry = createRegistry();
	const harness = await Harness.open(
		options.storage,
		{ models: options.models, registry },
		BACKGROUND_CONTEXT,
	);
	let closing: Promise<void> | undefined;
	return {
		harness,
		registry,
		close() {
			closing ??= harness.close(BACKGROUND_CONTEXT);
			return closing;
		},
	};
}
