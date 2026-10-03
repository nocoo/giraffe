import { ApiError, type GiraffeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { type AnalysisReport, DOMAINS, type Domain, specialistSchema } from "./contracts.ts";
import { decisionClient } from "./decision.ts";
import { type AnalysisInput, buildInput, digest, object } from "./evidence.ts";
import { finalizeReport } from "./runtime.ts";
import type { workConversations } from "./work-conversations.ts";
import type { WorkRepository } from "./work-priority.ts";

export function reportInput(id: string, report: AnalysisReport) {
	return {
		id,
		type: "github-analysis",
		status: "completed",
		repository: report.repository,
		source_version: report.sourceVersion,
		payload: report,
	};
}

export function combineInputs(domain: Domain, inputs: AnalysisInput[], now: string): AnalysisInput {
	const all = inputs.flatMap((input) => input.evidence);
	return {
		scope: "global",
		repository: null,
		domain,
		sourceVersion: digest(inputs.map((input) => input.sourceVersion)),
		observedAt: inputs.map((input) => input.observedAt).sort()[0] ?? now,
		sources: [
			...new Map(
				inputs
					.flatMap((input) => input.sources)
					.map((source) => [
						`account:${source.resource}`,
						{ ...source, resource: `account:${source.resource}` },
					]),
			).values(),
		],
		evidence: all.slice(0, 24),
		omitted: inputs.reduce((sum, input) => sum + input.omitted, 0) + Math.max(0, all.length - 24),
		counts: {
			repositories: inputs.length,
			...Object.fromEntries(
				inputs.flatMap((input) =>
					Object.entries(input.counts).map(([key, count]) => [`${input.repository}:${key}`, count]),
				),
			),
		},
		limitations: [
			...new Set(inputs.flatMap((input) => input.limitations)),
			...(all.length > 24
				? ["Portfolio evidence is capped at 24 items; omitted evidence is not successful coverage."]
				: []),
		],
	};
}

export function residentAnalysis(options: {
	client: GiraffeClient;
	config: Config;
	conversations: ReturnType<typeof workConversations>;
	dryRun: boolean;
	log: (line: string) => void;
}) {
	return async (repositories: WorkRepository[], runId: string) => {
		const key = `${runId}:analysis-input`;
		const saved = await options.conversations.checkpoint(key);
		const frozen = saved ? JSON.parse(saved) : null;
		const now: string = frozen?.now ?? new Date().toISOString();
		const catalog = frozen?.catalog ?? (await options.client.observation("repos?scope=all"));
		const collected: [Domain, Awaited<ReturnType<GiraffeClient["observation"]>>][] =
			frozen?.collected ??
			(await Promise.all(
				DOMAINS.map(async (domain) => {
					let source: Awaited<ReturnType<GiraffeClient["observation"]>>;
					try {
						source = await options.client.observation(
							`${domain === "cd" ? "factory" : domain}?scope=all`,
						);
					} catch (error) {
						if (!(error instanceof ApiError) || error.code !== "snapshot_missing") throw error;
						source = {
							...catalog,
							data: {},
							sourceVersion: `missing:${domain}`,
							fetchedAt: null,
							unavailable: true,
						};
						options.log(`[分析证据缺失] ${domain} 快照不存在，报告保持 unknown。`);
					}
					return [domain, source] as const;
				}),
			));
		const prepared = new Map<Domain, AnalysisInput>();
		for (const [domain, source] of collected) {
			const input = buildInput("portfolio/all", domain, [source], now);
			prepared.set(domain, { ...input, scope: "global", repository: null });
		}
		const judgments: Awaited<ReturnType<ReturnType<typeof decisionClient>>> =
			frozen?.judgments ?? (await decisionClient(options.config)([...prepared.values()]));
		if (!frozen)
			await options.conversations.saveCheckpoint(
				key,
				JSON.stringify({ now, catalog, collected, judgments, repositories }),
			);
		const portfolio: WorkRepository[] = frozen?.repositories ?? repositories;
		const outputs = await Promise.allSettled(
			DOMAINS.map(async (domain) => {
				const source = collected.find(([key]) => key === domain)?.[1];
				if (!source) throw new Error("Analysis source missing.");
				const inputs: AnalysisInput[] = [];
				const rows = (value: unknown) => (Array.isArray(value) ? value.map(object) : []);
				for (const repository of portfolio) {
					const data =
						domain === "issues"
							? {
									issues: rows(source.data.issues).filter(
										(item) => item.name_with_owner === repository.repository,
									),
								}
							: domain === "prs"
								? {
										pull_requests: rows(source.data.pull_requests).filter(
											(item) => item.name_with_owner === repository.repository,
										),
									}
								: domain === "ci"
									? {
											runs: rows(source.data.streams)
												.filter((item) => item.repo === repository.repository)
												.flatMap((stream) =>
													rows(stream.recent).map((run) => ({
														...run,
														name: stream.workflow,
														head_branch: stream.branch,
														conclusion: run.outcome,
														created_at: run.at,
													})),
												),
										}
									: {
											releases: [],
											default_branch: rows(source.data.repos).find(
												(item) => item.name === repository.repository,
											)?.branch,
										};
					const input = buildInput(repository.repository, domain, [{ ...source, data }], now);
					if (domain === "cd")
						input.limitations.push(
							"Factory release totals do not prove deployment health; no verified deployment observation was supplied.",
						);
					inputs.push(input);
				}
				const input = combineInputs(domain, inputs, now);
				const catalogSource = buildInput("portfolio/all", domain, [catalog], now).sources[0];
				if (catalogSource) input.sources.push({ ...catalogSource, resource: "account:repos" });
				input.sourceVersion = digest(input.sources);
				const judgment = judgments[domain];
				if (!judgment) throw new Error("Domain judgment missing.");
				const reply = await options.conversations.run({
					key: `analysis:${domain}`,
					requestId: `${runId}:analysis:${domain}`,
					role: options.config.roles.executor,
					schema: specialistSchema,
					instructions: `You are the resident ${domain} analyst, running independently alongside coordinator planning. Analyze saved observations only. Return {verdict:'pass'|'attention'|'fail'|'unknown',summary,findings:[{title,detail,evidenceIds}],actions:[{title,reason,priority:'now'|'next'|'later'}],limitations:[]}. Findings max 8, actions max 6. Missing/stale evidence cannot pass. Never claim merge/deployment authorization. CD requires verified deployment evidence.`,
					input: { evidence: input, judgment },
				});
				const report = finalizeReport(
					{
						...reply.result,
						verdict:
							(source.unavailable || input.omitted > 0) && reply.result.verdict === "pass"
								? "unknown"
								: reply.result.verdict,
					},
					input,
					judgment,
					{
						orchestrator: options.config.roles.orchestrator.model,
						executor: options.config.roles.executor.model,
						decision: judgment.model,
						conversationId: reply.conversationId,
						jobId: runId,
					},
					now,
				);
				if (!options.dryRun) {
					const id = `analysis-${digest({ runId, domain }).slice(0, 48)}`;
					if (!(await options.client.get("reports", id)))
						await options.client.create("reports", reportInput(id, report));
				}
				options.log(
					`[常驻 ${domain} 会话 ${reply.conversationId}] ${report.verdict}：${report.summary} | ${options.dryRun ? "dry run 不写线上" : "已写线上报告"}`,
				);
			}),
		);
		if (outputs.some((output) => output.status === "rejected")) {
			for (const [index, output] of outputs.entries())
				if (output.status === "rejected")
					options.log(
						`[常驻 ${DOMAINS[index]} 失败] ${output.reason instanceof Error ? output.reason.message : "analysis failed"}`,
					);
			throw new Error("One or more resident analyses failed.");
		}
	};
}
