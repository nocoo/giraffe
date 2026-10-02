import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { GiraffeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { createCron } from "./cron.ts";
import { digest } from "./evidence.ts";
import type { IssueCandidate } from "./repair-contracts.ts";
import { repairDecision } from "./repair-decision.ts";
import { createRepairEngine } from "./repair-engine.ts";
import { repairModels } from "./repair-models.ts";
import { dependencyCandidates, packageTarget, verifyLiveIssue } from "./repair-source.ts";
import { repairTelemetry } from "./repair-telemetry.ts";
import { WorkspaceDriver } from "./repair-workspace.ts";
import type { AgentRuntime } from "./runtime.ts";

const Cycles = defineDocFamily<{ candidates: IssueCandidate[] | null; cursor: number }, null>({
	kind: "giraffe.repair-cycles",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ candidates: null, cursor: 0 }),
	checkpointWhen: () => true,
});

export async function repairDaemon(options: {
	runtime: AgentRuntime;
	client: GiraffeClient;
	config: Config;
	log: (line: string) => void;
}) {
	const { config, client, runtime, log } = options;
	const identity = await client.me();
	const telemetry = repairTelemetry(client);
	const driver = new WorkspaceDriver({
		profiles: config.repairs.profiles,
		registry: config.repairs.registry,
	});
	let engine: ReturnType<typeof createRepairEngine>;
	const models = repairModels({
		runtime,
		config,
		driver,
		log,
		onEvent: (id, message) => engine.trace(id, message),
	});
	const decide = repairDecision(config);
	engine = createRepairEngine({
		harness: runtime.harness,
		driver,
		models,
		verify: (candidate, signal) => verifyLiveIssue(candidate, identity.login, undefined, signal),
		admit: async (issue) => {
			if (!config.repairs.profiles[issue.repository])
				return {
					eligible: false,
					reason:
						"No trusted repository repair profile; configure checks, hooks and writable files locally.",
				};
			return decide(issue);
		},
		verifyPackage: (plan) => packageTarget(plan, config.repairs.registry),
		publish: telemetry.progress,
		isPaused: telemetry.paused,
		maxRounds: config.repairs.maxRounds,
		allowPush: config.repairs.push,
		grantVersion: digest(config.repairs),
		prerequisite: (candidate) =>
			!config.repairs.profiles[candidate.repository]
				? "No trusted repository profile; configure checks, hooks and writable files locally."
				: null,
		log,
	});
	const cron = await createCron({
		harness: runtime.harness,
		expression: config.repairs.cron,
		timezone: config.repairs.timezone,
		enabled: config.repairs.enabled,
		maxRounds: config.repairs.maxRounds,
		publish: telemetry.cron,
		isPaused: telemetry.paused,
		log,
		run: async (occurrence, signal) => {
			let cycle = await runtime.harness.snapshot(Cycles, occurrence, BACKGROUND_CONTEXT);
			if (!cycle?.candidates) {
				const discovered = await dependencyCandidates(client, config, new Date().toISOString());
				await runtime.harness.commit(async (tx) => {
					(await tx.doc(Cycles, occurrence, null)).candidates = discovered;
				}, BACKGROUND_CONTEXT);
				cycle = await runtime.harness.snapshot(Cycles, occurrence, BACKGROUND_CONTEXT);
			}
			const candidates = cycle?.candidates ?? [];
			log(
				`[发现] ${candidates.length} 个依赖升级候选，使用本机工具链串行执行；未配置仓库检查策略的任务将阻塞。`,
			);
			for (let index = cycle?.cursor ?? 0; index < candidates.length; index++) {
				if (signal.aborted || (await telemetry.paused())) break;
				const candidate = candidates[index] as IssueCandidate;
				await engine.run(candidate, signal);
				if (signal.aborted || (await telemetry.paused())) break;
				await runtime.harness.commit(async (tx) => {
					(await tx.doc(Cycles, occurrence, null)).cursor = index + 1;
				}, BACKGROUND_CONTEXT);
			}
		},
	});
	return { ...cron, close: () => models.close() };
}
