import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.ts";
import { digest } from "./evidence.ts";
import { githubRead, WorkTransportError } from "./github.ts";
import type { RepositoryProgress } from "./work-contracts.ts";
import type { workConversations } from "./work-conversations.ts";
import type { RankedRepository, WorkRepository, workDecisions } from "./work-priority.ts";
import { reviewWork } from "./work-review.ts";
import { readWorkTask } from "./work-tasks.ts";
import { verifyWorkRepository, workerActions } from "./work-tools.ts";
import type { WorkInspection, WorkWorkspace } from "./work-workspace.ts";

export type { RepositoryProgress } from "./work-contracts.ts";

const planSchema = z.object({
	repositories: z.array(
		z.object({
			repository: z.string(),
			tasks: z.array(z.string().regex(/^(dependency|pr|ci):[1-9]\d*$/)),
			retainChanges: z.boolean(),
			reason: z.string().min(1),
		}),
	),
});
const handoffSchema = z.object({
	summary: z.string().min(1),
	steps: z.array(z.string()).min(1),
	tasks: z.array(z.string().regex(/^(dependency|pr|ci):[1-9]\d*$/)),
	ready: z.boolean(),
});
const reviewSchema = z.object({
	head: z.string().min(1),
	findings: z.array(z.string().min(1).max(2000)).max(20),
});
export type WorkHandoff = {
	repository: string;
	path: string;
	conversationId: number;
	summary: string;
	dryRun: boolean;
};
const taskIdentity = (repository: WorkRepository) =>
	`task-${digest({ repository: repository.repository, items: repository.tasks.map(({ id, updatedAt }) => ({ id, updatedAt })).sort((left, right) => left.id.localeCompare(right.id)) })}`;

export async function runCoordinator(options: {
	dryRun: boolean;
	push?: boolean;
	limit: number;
	repositories?: string[];
	runId?: string;
	load: () => Promise<WorkRepository[]>;
	decisions: ReturnType<typeof workDecisions>;
	driver: WorkWorkspace;
	conversations: ReturnType<typeof workConversations>;
	config: Config;
	analyze: (repositories: WorkRepository[], runId: string) => Promise<void>;
	log: (line: string) => void;
	signal?: AbortSignal;
	observe?: (repository: string, state: RepositoryProgress) => void;
	completedPublications?: string[];
	analysisAttention?: () => void;
}): Promise<WorkHandoff[]> {
	const { log, config, driver, conversations } = options;
	const runId = options.runId ?? randomUUID();
	const checkpoint = await conversations.checkpoint(runId);
	const recovered = checkpoint
		? (JSON.parse(checkpoint) as {
				selected: { repository: RankedRepository; workspace: WorkInspection }[];
				plan: z.infer<typeof planSchema>;
				prepared: Record<string, WorkInspection>;
				committed: Record<
					string,
					{
						task: string;
						head: string | null;
						outcome: "committed" | "reviewed_no_change" | "deferred";
						reason?: string;
					}[]
				>;
			})
		: null;
	const portfolio = await options.load();
	log(
		`[主控] API 快照：${portfolio.length} 个自有仓库，${portfolio.reduce((sum, repo) => sum + repo.issues.length, 0)} 条 Issue，${portfolio.reduce((sum, repo) => sum + repo.prs.length, 0)} 条 PR`,
	);
	const selected: { repository: RankedRepository; workspace: WorkInspection }[] = [];
	const analysis = options.analyze(portfolio, runId).catch(() => {
		log("[分析关注] 常驻分析或报告交付失败；保留未知证据，下一周期重试，不阻塞仓库工作。 ");
		options.analysisAttention?.();
	});
	try {
		const ranked = recovered
			? []
			: await options.decisions.prioritize(
					portfolio.filter((repo) => repo.issues.length || repo.prs.length || repo.tasks.length),
					log,
				);
		for (const ranking of ranked) {
			const repository = {
				...ranking,
				tasks: [...ranking.tasks].sort(
					(left, right) =>
						(ranking.items.find((item) => item.id === right.id)?.probability ?? 0) -
						(ranking.items.find((item) => item.id === left.id)?.probability ?? 0),
				),
			};
			if (ranking.choice === "none") continue;
			if (options.repositories && !options.repositories.includes(repository.repository)) continue;
			if (!repository.tasks.length) continue;
			const settled = await conversations.checkpoint(taskIdentity(repository));
			if (settled && JSON.parse(settled).status !== "locally_reviewed") {
				options.observe?.(repository.repository, JSON.parse(settled));
				log(`[任务终态] ${repository.repository} 来源未变，不占本周期仓库额度。`);
				continue;
			}
			if (selected.length >= options.limit) continue;
			try {
				const workspace = await driver.inspect(repository.repository);
				selected.push({ repository, workspace });
				log(
					`[候选] ${repository.repository} | ${repository.issues.length} Issues / ${repository.prs.length} PRs | ${repository.stale ? "快照过期，执行前需复核" : "快照有效"} | ${workspace.path} | ${workspace.branch} ahead=${workspace.ahead} behind=${workspace.behind} | ${workspace.status ? "有未提交改动，交主控审查" : "工作区干净"}`,
				);
			} catch (error) {
				if (error instanceof WorkTransportError) throw error;
				log(
					`[工作区阻塞] ${repository.repository}：${error instanceof Error ? error.message : "inspection failed"}`,
				);
			}
		}
		if (recovered) selected.push(...recovered.selected);
		if (!selected.length) {
			log("[主控] 本周期无可执行仓库，保存分析后完成。");
			await analysis;
			return [];
		}
		const planned = recovered
			? { result: recovered.plan }
			: await conversations.run({
					key: "controller",
					requestId: `${runId}:plan`,
					role: config.roles.orchestrator,
					schema: planSchema,
					instructions:
						"You are the sole coordinator. Order every repository and authorized task using Jev priorities. Assigned issues includes exact [CO] PR candidates marked kind:pr; these authorize code review/fixes only, not merging or closing PRs. Inspect dirty diffs, preserve user work and explain retainChanges; never discard it. Unpushed main commits are not dirty. You cannot approve unknown/truncated changes or broaden host scope. Return {repositories:[{repository,tasks:[ordered namespaced task IDs],retainChanges:boolean,reason:string}]}. Include all provided repositories and assigned tasks exactly once.",
					input: {
						dryRun: options.dryRun,
						repositories: selected.map(({ repository, workspace }) => ({
							...repository,
							workspace,
						})),
					},
				});
		const state = recovered ?? { selected, plan: planned.result, prepared: {}, committed: {} };
		const save = () => conversations.saveCheckpoint(runId, JSON.stringify(state));
		await save();
		if (
			new Set(planned.result.repositories.map((item) => item.repository)).size !==
				selected.length ||
			planned.result.repositories.length !== selected.length
		)
			throw new Error("Controller omitted or duplicated a repository.");
		const handoffs: WorkHandoff[] = [];
		for (const plan of planned.result.repositories) {
			if (options.completedPublications?.includes(plan.repository)) continue;
			const progress: RepositoryProgress = {
				tasks: plan.tasks,
				worker: null,
				reviewer: null,
				round: 0,
				findings: [],
				head: null,
				status: "preparing",
			};
			const observe = () => options.observe?.(plan.repository, structuredClone(progress));
			observe();
			if (options.signal?.aborted) throw new Error("Coordinator cancelled.");
			const candidate = selected.find((item) => item.repository.repository === plan.repository);
			if (
				!candidate ||
				JSON.stringify([...plan.tasks].sort((left, right) => left.localeCompare(right))) !==
					JSON.stringify(
						candidate.repository.tasks
							.map((item) => item.id)
							.sort((left, right) => left.localeCompare(right)),
					)
			)
				throw new Error("Controller issue scope mismatch.");
			const ordered = plan.tasks.map(
				(id) =>
					candidate.repository.tasks.find(
						(issue) => issue.id === id,
					) as WorkRepository["tasks"][number],
			);
			const repository = { ...candidate.repository, tasks: ordered };
			const taskKey = taskIdentity(repository);
			const terminalTask = await conversations.checkpoint(taskKey);
			if (terminalTask && JSON.parse(terminalTask).status !== "locally_reviewed") {
				Object.assign(progress, JSON.parse(terminalTask));
				observe();
				log(`[任务终态] ${plan.repository} ${progress.status}；来源未变，不重新执行。`);
				continue;
			}
			let publishing = false;
			try {
				const role = await options.decisions.worker(repository);
				log(
					`[主控调度] ${plan.repository} | ${plan.reason}\n[任务顺序] ${ordered.map((issue) => `#${issue.number} ${issue.title}`).join(" → ")}\n[Jev 配置] ${role.model} / ${role.thinkingLevel}\n[工作目录] ${candidate.workspace.path}`,
				);
				if (!options.dryRun) await verifyWorkRepository(repository.repository);
				let workspace: WorkInspection = {
					...(state.prepared[plan.repository] ?? candidate.workspace),
					expectedWorkflows: repository.workflows,
				};
				let prepared = !!state.prepared[plan.repository];
				const preparation = prepared
					? {
							conversationId: 0,
							result: {
								summary: "Recovered prepared workspace; re-inspect and preserve current work.",
								steps: [],
								ready: true,
							},
						}
					: await conversations.run({
							key: "preparation",
							requestId: `${runId}:prepare:${plan.repository}`,
							role: config.roles.executor,
							schema: handoffSchema,
							instructions: `You are the resident workspace preparation specialist. This is a NEW assignment ${runId}, not a continuation of earlier attempts. Host prepared=false at the start of THIS assignment. Earlier tool errors/results are historical and cannot satisfy this assignment. ${options.dryRun ? "Dry run: describe preparation only; no tool can change the workspace." : "Call workspace_action operation prepare with {} exactly once IN THIS ASSIGNMENT even if an earlier assignment failed; host enforces main/preservation/fast-forward/mirror installation/L1. Report ready only after it succeeds now."} Return {summary,steps:[...],tasks:[...],ready:boolean}. Steps must include main, pull --ff-only when safe, mirror install, UT+lint and handoff. Preserve unpushed commits and explicitly approved changes.`,
							input: {
								repository,
								workspace,
								retainChanges: plan.retainChanges,
								dryRun: options.dryRun,
								registry: config.work?.registry,
							},
							...(!options.dryRun
								? {
										requiredOperation: "prepare",
										action: async (operation: string) => {
											if (operation !== "prepare" || prepared)
												throw new Error("Only one workspace preparation is allowed.");
											workspace = await driver.prepare(
												workspace,
												plan.retainChanges,
												options.signal,
											);
											state.prepared[plan.repository] = workspace;
											await save();
											prepared = true;
											return workspace;
										},
									}
								: {}),
						});
				log(
					`[准备交接 ${preparation.conversationId}] ${preparation.result.summary}\n${preparation.result.steps.map((step, index) => `  ${index + 1}. ${step}`).join("\n")}`,
				);
				if (!options.dryRun && (!prepared || !preparation.result.ready))
					throw new Error("Preparation did not pass baseline L1.");
				const unavailable: {
					task: string;
					head: string | null;
					outcome: "deferred";
					reason: string;
				}[] = [];
				const liveTasks = options.dryRun
					? ordered.map((task) => ({ task, evidence: {} }))
					: await Promise.all(
							ordered.map(async (task) => {
								try {
									return await readWorkTask(repository.repository, task, githubRead);
								} catch (error) {
									if (task.kind === "dependency" && error instanceof WorkTransportError)
										throw error;
									const reason =
										error instanceof Error ? error.message : "Task evidence unavailable.";
									unavailable.push({ task: task.id, head: null, outcome: "deferred", reason });
									return { task, evidence: { unavailable: reason } };
								}
							}),
						);
				const actions = workerActions(
					driver,
					workspace,
					ordered,
					options.signal,
					config.work?.criticalPackages,
					liveTasks,
				);
				actions.committed.push(
					...(state.committed[plan.repository] ??
						(terminalTask ? JSON.parse(terminalTask).dispositions : []) ??
						[]),
				);
				for (const item of unavailable)
					if (!actions.committed.some((done) => done.task === item.task))
						actions.committed.push(item);
				const action = async (operation: string, args: Record<string, unknown>) => {
					const result = await actions.action(operation, args);
					progress.dispositions = actions.committed.map(({ task, outcome, reason }) => ({
						task,
						outcome,
						...(reason ? { reason } : {}),
					}));
					observe();
					state.committed[plan.repository] = actions.committed;
					await save();
					return result;
				};
				const files = options.dryRun ? [] : await driver.files(workspace);
				const runWorker = async (round: number, findings: string[]) => {
					Object.assign(progress, { round, findings, status: "fixing" });
					observe();
					const worker = await conversations.run({
						key: `worker:${plan.repository}`,
						requestId: `${runId}:worker:${plan.repository}:${round}`,
						role,
						schema: handoffSchema,
						instructions: `You are the dedicated worker for this repository. Process supplied tasks in priority order on main, obey repository instructions, TDD and atomic commits with normal hooks. No branches/worktrees/push/issue closure. ${options.dryRun ? "DRY RUN: do not run code. Repeat every assigned issue, workdir, priority and approximate fix/test/commit process; honestly state nothing executed." : "Available workspace_action operations: resolve {task,outcome:reviewed_no_change|deferred,reason} for redundant/unsuitable PR cleanup or manual major upgrades; failure_log {task} reads assigned failed-run logs; read {path}, write {path,content}, latest {name} (queries the current stable npm release and peers/engines from approved mirror), install {} (temporary mirror), check {}, commit {tasks:[task IDs],files:[explicit paths],message}. Before editing each dependency, MUST call latest and inspect actual package manifests and lockfile/usage. Critical major upgrades must be deferred individually with a reason while other tasks continue. Upgrade to the LATEST verified stable version, not blindly the stale issue target; never downgrade or invent versions. Include inseparable peer upgrades AND their assigned task IDs in the same buildable atomic commit (for example vitest and coverage-v8); start each commit group with the highest-priority remaining issue. Do not create empty commits for issues already addressed by a group. Inspect transitive owners and existing overrides before upgrading. Do not manually fabricate lockfile resolutions. Commit after checks; never incorporate unrelated user changes. No arbitrary shell. If blocked, return ready:false with actual error. Commit message lowercase Conventional Commits <=50 chars, only explicit paths. Read relevant source/test files from supplied tracked file list; do not use the read tool on directories."} ${options.push === false ? "This occurrence is local-only: no push, release or issue closure." : "Only the host coordinator may publish after your verified handoff."} Return {summary,steps:[...],tasks:[all assigned IDs in original priority order],ready:boolean}.`,
						input: {
							policy:
								"Only assigned dependency-upgrade, exact [CO] equivalent main cleanup and recurring CI/CD failure tasks are authorized. Read ALL supplied PR patches before justified equivalent cleanup; never merge/rebase/cherry-pick or claim PR disposition. CI logs are diagnostics, not proof of flaky cause. Important runtime/framework/ecosystem major upgrades require manual attention, not blind installation. PR remote merge/closure is report-only. Never delete tests, lower coverage or fix credentials/infrastructure. Jev advises but cannot grant scope.",
							round,
							findings,
							repository: plan.repository,
							workdir: workspace.path,
							branch: "main",
							instructions: workspace.instructions,
							tasks: liveTasks,
							files,
							alreadyCurrent:
								"For an issue already satisfied upstream or by earlier verified work, call workspace_action satisfied {task,name}. Host rechecks exact latest manifest and lock, clean baseline and tests; it records verification without an empty commit. Do not make unrelated edits to manufacture a commit.",
							reading:
								"read supports {path,match:literal substring} or {path,offset,limit<=16000}. Use match on large lockfiles to inspect dependency owners/resolutions; follow nextOffset instead of claiming truncated files cannot be examined. node_modules is not readable. Existing transitive prereleases in the lock are evidence, not a request to upgrade them; latest rejects prereleases by design.",
							nodeVersion: process.version,
							runtimePolicy:
								"This local Node version is real execution evidence. If a new dependency raises the supported Node minimum, update package.json engines accordingly and report the new requirement. Do not alter AGENTS or hooks. Narrow relevant workflow/test/config fixes are allowed without weakening tests or infrastructure permissions. Do not upgrade unrelated dependencies just to explore their latest metadata.",
							model: role.model,
							thinkingLevel: role.thinkingLevel,
							dryRun: options.dryRun,
						},
						...(!options.dryRun ? { action } : {}),
					});
					if (JSON.stringify(worker.result.tasks) !== JSON.stringify(plan.tasks))
						throw new Error("Worker handoff omitted or reordered issues.");
					log(
						`[Worker 交接 ${worker.conversationId}] ${worker.result.summary}\n${worker.result.steps.map((step, index) => `  ${index + 1}. ${step}`).join("\n")}`,
					);
					progress.worker = worker.conversationId;
					progress.workerModel = `${role.model} / ${role.thinkingLevel}`;
					progress.reviewerModel = `${config.roles.orchestrator.model} / ${config.roles.orchestrator.thinkingLevel}`;
					observe();
					if (
						!options.dryRun &&
						(!worker.result.ready || actions.committed.length !== plan.tasks.length)
					)
						throw new Error("Worker has not verified and committed every assigned issue.");
					return worker;
				};
				let worker: Awaited<ReturnType<typeof runWorker>> | undefined;
				if (!options.dryRun) {
					const reviewKey = taskKey;
					const approvedHead = await reviewWork({
						load: () => conversations.reviewState(reviewKey),
						save: (state) => conversations.saveReviewState(reviewKey, state),
						fix: async (round, findings) => {
							worker = await runWorker(round, findings);
						},
						check: async () => {
							progress.status = "checking";
							observe();
							await driver.check(workspace, options.signal);
							return (await driver.inspect(plan.repository)).head;
						},
						review: async (head, round) => {
							Object.assign(progress, { head, round, status: "reviewing" });
							observe();
							const result = await conversations.run({
								key: `reviewer:${plan.repository}`,
								requestId: `${runId}:review:${plan.repository}:${round}`,
								role: config.roles.orchestrator,
								schema: reviewSchema,
								instructions:
									"You are the dedicated independent read-only reviewer, not the controller or worker. Inspect exact changes and relevant source/tests using only read. Require tests and scope/preservation safety; no browser/deployment approval or immutable proof hierarchy. Never delete tests, lower coverage or repair credentials/infrastructure. Distinguish suspected flakiness from proven test causes. Return {head,findings:[actionable findings]}; empty findings approves only this exact checked HEAD.",
								input: {
									head,
									round,
									tasks: liveTasks,
									workspace,
									changes: await driver.changes(workspace),
									files,
									dispositions: actions.committed,
									checks: { passed: true, head },
								},
								action: async (operation, args) => {
									if (operation !== "read") throw new Error("Reviewer is read-only.");
									return actions.action(operation, args);
								},
							});
							log(
								`[独立审查 ${result.conversationId}] round=${round} HEAD=${head} findings=${JSON.stringify(result.result.findings)}`,
							);
							Object.assign(progress, {
								reviewer: result.conversationId,
								findings: result.result.findings,
							});
							observe();
							return result.result;
						},
						...(options.signal ? { signal: options.signal } : {}),
					});
					await Promise.all(
						ordered
							.filter(
								(task) =>
									!actions.committed.some(
										(done) => done.task === task.id && done.outcome === "deferred",
									),
							)
							.map((task) => readWorkTask(repository.repository, task, githubRead)),
					);
					const deferred = actions.committed.filter((done) => done.outcome === "deferred");
					workspace.expectedWorkflows = repository.workflows;
					progress.dispositions = actions.committed.map(({ task, outcome, reason }) => ({
						task,
						outcome,
						...(reason ? { reason } : {}),
					}));
					Object.assign(progress, {
						head: approvedHead,
						status: "signed_off",
						findings: deferred.map((done) => `${done.task}: ${done.reason}`),
					});
					observe();
					if (
						options.push !== false &&
						(actions.committed.some((done) => done.outcome === "committed") ||
							ordered.some(
								(task) =>
									task.kind === "dependency" &&
									actions.committed.some(
										(done) => done.task === task.id && done.outcome === "reviewed_no_change",
									),
							))
					) {
						publishing = true;
						const closed = ordered
							.filter(
								(task) =>
									task.kind === "dependency" &&
									actions.committed.some(
										(done) => done.task === task.id && done.outcome !== "deferred",
									),
							)
							.map((task) => task.number);
						await driver.publish(workspace, approvedHead, closed, options.signal);
						publishing = false;
						log(
							`[主控发布] ${plan.repository} 已验证 push，然后关闭 ${closed.length} 个依赖 Issue；PR 处置仅报告`,
						);
						progress.status = deferred.length ? "deferred" : "pushed";
						observe();
					} else {
						await driver.check(workspace, options.signal);
						const final = await driver.inspect(plan.repository);
						if (
							final.branch !== "main" ||
							final.head !== approvedHead ||
							final.status !== workspace.status ||
							final.diff !== workspace.diff
						)
							throw new Error(
								"Final local handoff does not match committed HEAD and retained baseline.",
							);
						log(`[本地完成] ${plan.repository} HEAD=${final.head}，验证通过；不推送、不关闭 Issue`);
						progress.status =
							options.push === false
								? "locally_reviewed"
								: deferred.length
									? "deferred"
									: "reviewed_no_change";
						observe();
					}
				} else {
					worker = await runWorker(0, []);
					log(`[DRY RUN 完成] ${plan.repository}：未 pull/安装/改码/测试/提交/push/关闭 Issue`);
				}
				if (!options.dryRun)
					await conversations.saveCheckpoint(
						taskKey,
						JSON.stringify({ ...progress, dispositions: actions.committed }),
					);
				handoffs.push({
					repository: plan.repository,
					path: workspace.path,
					conversationId: worker?.conversationId ?? 0,
					summary: worker?.result.summary ?? "Recovered independently approved checked HEAD.",
					dryRun: options.dryRun,
				});
			} catch (error) {
				if (publishing || error instanceof WorkTransportError || options.signal?.aborted)
					throw error;
				const reviewed = await conversations.reviewState(taskKey);
				progress.round = reviewed.round;
				progress.findings = reviewed.findings;
				progress.status = progress.round >= 20 ? "exhausted" : "blocked";
				observe();
				const message = `${plan.repository}: ${error instanceof Error ? error.message : "Repository work failed"}`;
				log(`[仓库阻塞] ${message}`);
				if (!progress.findings.length) progress.findings = [message.slice(0, 2000)];
				observe();
				await conversations.saveCheckpoint(taskKey, JSON.stringify(progress));
			}
		}
		await analysis;
		return handoffs;
	} finally {
		await analysis;
	}
}
