import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { GiraffeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { createCron } from "./cron.ts";
import { digest } from "./evidence.ts";
import { githubRead } from "./github.ts";
import type { AgentRuntime } from "./runtime.ts";
import { residentAnalysis } from "./work-analysis.ts";
import { workConversations } from "./work-conversations.ts";
import { type RepositoryProgress, runCoordinator } from "./work-coordinator.ts";
import { type FollowUpState, followUp } from "./work-followup.ts";
import { loadPortfolio, workDecisions } from "./work-priority.ts";
import { WorkWorkspace } from "./work-workspace.ts";

type Occurrence = {
	grant: string | null;
	completed: boolean;
	published: Record<
		string,
		{ head: string; issues: number[]; closed: number[]; followup: FollowUpState }
	>;
};
const Occurrences = defineDocFamily<Occurrence, null>({
	kind: "giraffe.work-occurrences",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ grant: null, completed: false, published: {} }),
	checkpointWhen: () => true,
});

export async function workDaemon(options: {
	runtime: AgentRuntime;
	client: GiraffeClient;
	config: Config;
	log: (line: string) => void;
	dryRun: boolean;
	push: boolean;
	limit: number;
	repositories?: string[];
	once?: boolean;
	wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}) {
	const { runtime, client, config, log } = options;
	const context = BACKGROUND_CONTEXT;
	let activeLog = log;
	const conversations = workConversations({ runtime, config, log: (line) => activeLog(line) });
	const driver = new WorkWorkspace({
		registry: config.work.registry,
		log: (line) => activeLog(line),
	});
	const nativePublish = driver.publish.bind(driver);
	const upsert = async (
		collection: "jobs" | "records",
		id: string,
		type: string,
		status: string,
		payload: Record<string, unknown>,
	) => {
		const existing = await client.get(collection, id);
		const value = { type, status, repository: null, source_version: null, payload };
		if (existing) await client.update(collection, existing, value);
		else await client.create(collection, { id, ...value });
	};
	const paused = async () => (await client.get("records", "work-control"))?.payload.paused === true;
	const cron = await createCron({
		harness: runtime.harness,
		expression: config.work.cron,
		timezone: config.work.timezone,
		enabled: true,
		maxRounds: 20,
		isPaused: options.dryRun ? async () => false : paused,
		publish: options.dryRun
			? async () => {}
			: (value) => upsert("records", "work-cron", "work-cron", value.state, value),
		log,
		propagate: options.once ?? false,
		run: async (occurrence, signal) => {
			const id = `work-${digest(occurrence).slice(0, 40)}`;
			const progress = {
				occurrence,
				events: [] as string[],
				repositories: {} as Record<string, RepositoryProgress & { followup?: FollowUpState }>,
				updatedAt: new Date().toISOString(),
			};
			let terminal = false;
			const publish = async (status: string) => {
				progress.updatedAt = new Date().toISOString();
				if (!options.dryRun) await upsert("jobs", id, "work-run", status, progress);
			};
			const saved = await runtime.harness.snapshot(Occurrences, occurrence, context);
			const grant = digest({
				dryRun: options.dryRun,
				push: options.push,
				limit: options.limit,
				repositories: options.repositories ?? [],
			});
			if (saved?.grant && saved.grant !== grant)
				throw new Error("Active work occurrence mode/scope changed; resume with original flags.");
			await runtime.harness.commit(async (tx) => {
				(await tx.doc(Occurrences, occurrence, null)).grant = grant;
			}, context);
			if (saved?.completed) return;
			await publish("running");
			let queue = Promise.resolve();
			const trace = (line: string) => {
				log(line);
				progress.events.push(line.slice(0, 1000));
				progress.events = progress.events.slice(-40);
				while (progress.events.length && Buffer.byteLength(JSON.stringify(progress)) > 48000)
					progress.events.shift();
				queue = queue.then(() => publish("running")).catch(() => log("Work 进度暂时无法上报。"));
			};
			const timer = options.dryRun
				? undefined
				: setInterval(() => {
						if (!terminal) queue = queue.then(() => publish("running")).catch(() => {});
					}, 10000);
			activeLog = trace;
			try {
				driver.publish = async (workspace, head, issues, pushSignal) => {
					const state = await runtime.harness.snapshot(Occurrences, occurrence, context);
					const pushed = state?.published[workspace.repository];
					if (!pushed) {
						await nativePublish(workspace, head, issues, pushSignal);
						await runtime.harness.commit(async (tx) => {
							(await tx.doc(Occurrences, occurrence, null)).published[workspace.repository] = {
								head,
								issues,
								closed: [],
								followup: { checks: 0, nextAt: Date.now() + 600000, outcome: "pending", runs: [] },
							};
						}, context);
					} else if (pushed.head !== head)
						throw new Error("Published HEAD changed; manual attention required.");
					const current = await runtime.harness.snapshot(Occurrences, occurrence, context);
					const publication = current?.published[workspace.repository];
					for (const issue of publication?.issues ?? []) {
						if (publication?.closed.includes(issue)) continue;
						await driver.closeIssue(workspace, issue, signal);
						await runtime.harness.commit(async (tx) => {
							const item = (await tx.doc(Occurrences, occurrence, null)).published[
								workspace.repository
							];
							if (item) item.closed.push(issue);
						}, context);
						trace(`[Issue 已关闭] ${workspace.repository} #${issue}，推送证据已持久化`);
					}
					const followup = current?.published[workspace.repository]?.followup;
					if (!followup) throw new Error("Publication follow-up state missing.");
					await followUp({
						sha: head,
						state: followup,
						now: Date.now,
						wait: (ms) =>
							options.wait ? options.wait(ms, signal) : delay(ms, undefined, { signal }),
						read: () =>
							githubRead(
								`repos/${workspace.repository}/actions/runs?head_sha=${head}&per_page=100`,
								signal,
							),
						save: async (value) => {
							const summary = progress.repositories[workspace.repository];
							if (summary) summary.followup = value;
							await runtime.harness.commit(async (tx) => {
								const item = (await tx.doc(Occurrences, occurrence, null)).published[
									workspace.repository
								];
								if (item) item.followup = value;
							}, context);
							trace(
								`[推送跟进] ${workspace.repository} SHA=${head} checks=${value.checks}/3 ${value.outcome}`,
							);
						},
						signal,
					});
				};
				for (const [repository, published] of Object.entries(saved?.published ?? {})) {
					await driver.publish({ repository } as never, published.head, published.issues, signal);
				}
				await runCoordinator({
					...options,
					driver,
					conversations,
					runId: occurrence,
					load: async () =>
						(await loadPortfolio(client)).filter((repo) => !saved?.published[repo.repository]),
					decisions: workDecisions(config),
					analyze: residentAnalysis({
						client,
						config,
						conversations,
						dryRun: options.dryRun,
						log: trace,
					}),
					log: trace,
					observe: (repository, state) => {
						progress.repositories[repository] = { ...progress.repositories[repository], ...state };
						trace(
							`[仓库进度] ${repository} ${state.status} round=${state.round} HEAD=${state.head ?? "none"}`,
						);
					},
					signal,
				});
				await runtime.harness.commit(async (tx) => {
					(await tx.doc(Occurrences, occurrence, null)).completed = true;
				}, context);
				terminal = true;
				if (timer) clearInterval(timer);
				await queue;
				await publish("completed");
			} catch (error) {
				terminal = true;
				if (timer) clearInterval(timer);
				await queue;
				await publish("blocked");
				throw error;
			} finally {
				activeLog = log;
				if (timer) clearInterval(timer);
			}
		},
	});
	return { ...cron, close: () => conversations.close() };
}
