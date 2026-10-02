import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ApiError, type GiraffeClient } from "./client.ts";
import type { Config } from "./config.ts";
import {
	type AnalysisReport,
	type AnalysisRequest,
	analysisRequestSchema,
	DOMAINS,
	type Resource,
} from "./contracts.ts";
import {
	type AnalysisInput,
	collectInput,
	digest,
	globalInput,
	ownedRepositories,
	validReports,
} from "./evidence.ts";
import type { AgentRuntime } from "./runtime.ts";

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

export function createWatcher(options: {
	client: GiraffeClient;
	runtime: AgentRuntime;
	config: Config;
	version: string;
	runnerId?: string;
	log?: (message: string) => void;
	now?: () => string;
	collect?: typeof collectInput;
}) {
	const { client, runtime, config } = options;
	const runnerId =
		options.runnerId ??
		`runner-${digest({ host: hostname(), account: client.credential.account_id }).slice(0, 24)}`;
	const log = options.log ?? (() => {});
	const now = options.now ?? (() => new Date().toISOString());
	const collect = options.collect ?? collectInput;
	let currentJob: string | null = null;
	let cachedReports: AnalysisReport[] = [];

	async function heartbeat(state: "idle" | "working" | "offline" | "error") {
		const input = {
			id: runnerId,
			type: "heartbeat",
			status: state,
			repository: null,
			source_version: null,
			payload: {
				schemaVersion: 1,
				runnerId,
				version: options.version,
				lastSeenAt: now(),
				state,
				currentJob,
				models: {
					orchestrator: config.roles.orchestrator.model,
					executor: config.roles.executor.model,
					decision: config.roles.decision.model,
				},
				domains: [...DOMAINS],
			},
		};
		const existing = await client.get("records", runnerId);
		if (existing) {
			const { id: _id, ...patch } = input;
			await client.update("records", existing, patch);
		} else await client.create("records", input);
	}

	async function execute(id: string, inputs: AnalysisInput[]) {
		const pending = await runtime.job(id);
		const evidence = pending?.inputs ?? inputs;
		const jobInput = {
			id,
			type: "github-analysis",
			status: "running",
			repository: inputs[0]?.repository ?? null,
			source_version: digest(evidence.map((input) => input.sourceVersion)),
			payload: {
				request: {
					scope: inputs[0]?.scope ?? "global",
					repository: inputs[0]?.repository ?? null,
					domains: inputs.map((input) => input.domain),
				},
				runnerId,
				progress: "planning",
				startedAt: now(),
			},
		};
		let job = await client.create("jobs", jobInput);
		if (job.status === "completed") return;
		if (job.status === "failed" || job.status === "cancelled") {
			throw new Error(`Job ${id} already ended as ${job.status}; create a new request to retry.`);
		}
		currentJob = id;
		await heartbeat("working");
		try {
			const reports = await runtime.run(id, evidence);
			cachedReports.push(...reports);
			job = await client.update("jobs", job, {
				status: "completed",
				payload: {
					...jobInput.payload,
					progress: "completed",
					completedAt: now(),
					reports: reports.map((report) => ({
						domain: report.domain,
						verdict: report.verdict,
						sourceVersion: report.sourceVersion,
					})),
				},
			});
			log(`[任务完成] ${job.id}`);
		} catch (error) {
			if (runtime.closing) throw error;
			const live = await client.get("jobs", id);
			if (live && live.status !== "cancelled")
				await client.update("jobs", live, {
					status: "failed",
					payload: {
						...jobInput.payload,
						progress: "failed",
						error: "analysis_failed",
						failedAt: now(),
					},
				});
			throw error;
		} finally {
			currentJob = null;
		}
	}

	async function analyze(request: AnalysisRequest, id?: string) {
		if (id) {
			const saved = await runtime.job(id);
			if (saved) {
				await execute(id, saved.inputs);
				return;
			}
		}
		const instant = now();
		if (request.scope === "repo") {
			if (!request.repository) throw new Error("Repository is required.");
			const inputs: AnalysisInput[] = [];
			for (const domain of request.domains)
				inputs.push(await collect(client, request.repository, domain, instant));
			const jobId =
				id ??
				`watch-${digest({ scope: request.scope, repository: request.repository, sources: inputs.map((input) => input.sourceVersion), roles: config.roles, revision: 1 }).slice(0, 48)}`;
			await execute(jobId, inputs);
		} else {
			const identity = await client.me();
			const names = ownedRepositories(await client.observation("repos?scope=all"), identity.login);
			const inputs = request.domains.map((domain) =>
				globalInput(domain, cachedReports, names, instant),
			);
			const jobId =
				id ??
				`watch-${digest({ scope: "global", sources: inputs.map((input) => input.sourceVersion), roles: config.roles, revision: 1 }).slice(0, 48)}`;
			await execute(jobId, inputs);
		}
	}

	async function requests() {
		const jobs = (await client.list("jobs", { type: "analysis-request" })).filter(
			(job) =>
				job.status === "pending" || (job.status === "running" && job.payload.runnerId === runnerId),
		);
		for (const job of jobs) {
			const parsed = analysisRequestSchema.safeParse({
				scope: job.payload.scope,
				repository: job.payload.repository,
				domains: job.payload.domains,
			});
			if (!parsed.success) {
				await client.update("jobs", job, {
					status: "failed",
					payload: { error: "invalid_analysis_request" },
				});
				continue;
			}
			let claimed: Resource;
			try {
				claimed = await client.update("jobs", job, {
					status: "running",
					payload: { ...parsed.data, runnerId, startedAt: now() },
				});
			} catch (error) {
				if (error instanceof ApiError && error.status === 409) continue;
				throw error;
			}
			try {
				const identity = await client.me();
				const names = ownedRepositories(
					await client.observation("repos?scope=all"),
					identity.login,
				);
				if (parsed.data.repository && !names.includes(parsed.data.repository))
					throw new Error("Repository is outside analysis scope.");
				await analyze(parsed.data, `request-${digest(job.id).slice(0, 48)}`);
				await client.update("jobs", claimed, {
					status: "completed",
					payload: { ...claimed.payload, completedAt: now() },
				});
			} catch {
				if (runtime.closing) return;
				const latest = await client.get("jobs", job.id);
				if (latest?.status === "running")
					await client.update("jobs", latest, {
						status: "failed",
						payload: { ...latest.payload, error: "analysis_failed" },
					});
			}
		}
	}

	return {
		heartbeat,
		async once(request?: AnalysisRequest) {
			if (runtime.closing) return;
			cachedReports = validReports(await client.list("reports", { type: "github-analysis" }));
			await heartbeat("working");
			for (const id of await runtime.pending()) {
				const job = await runtime.job(id);
				if (job) await execute(id, job.inputs);
			}
			await requests();
			if (request) {
				const identity = await client.me();
				const names = ownedRepositories(
					await client.observation("repos?scope=all"),
					identity.login,
				);
				if (request.repository && !names.includes(request.repository))
					throw new Error("Repository is outside analysis scope.");
				await analyze(request);
			} else {
				const identity = await client.me();
				const names = ownedRepositories(
					await client.observation("repos?scope=all"),
					identity.login,
				);
				log(`[观察] ${identity.login}，${names.length} 个未归档自有非 fork 仓库`);
				for (const repository of names) {
					if (runtime.closing) break;
					try {
						await analyze({ scope: "repo", repository, domains: [...DOMAINS] });
					} catch {
						log(`[分析失败] ${repository}；旧报告保留，失败记录可在网页查看。`);
					}
				}
				if (!runtime.closing)
					await analyze({
						scope: "global",
						repository: null,
						domains: [...DOMAINS],
					});
			}
			await heartbeat("idle");
		},
		async watch(signal: AbortSignal) {
			let ticking = false;
			const timer = setInterval(() => {
				if (ticking) return;
				ticking = true;
				void heartbeat(currentJob ? "working" : "idle")
					.catch(() => log("[心跳失败] 请检查服务连接和登录状态。"))
					.finally(() => {
						ticking = false;
					});
			}, 30000);
			try {
				while (!signal.aborted) {
					try {
						await this.once();
					} catch {
						log("[观察失败] 将在下一周期重试；不把缺失数据当成通过。");
					}
					if (!signal.aborted)
						await delay(config.watch.intervalSeconds * 1000, undefined, {
							signal,
						}).catch(() => {});
				}
			} finally {
				clearInterval(timer);
				await heartbeat("offline").catch(() => {});
			}
		},
	};
}

export function parseAnalysisTarget(
	target: string | undefined,
	domain: string | undefined,
): AnalysisRequest {
	return analysisRequestSchema.parse({
		scope: target && target !== "all" ? "repo" : "global",
		repository: target && target !== "all" ? target : null,
		domains: domain ? [z.enum(DOMAINS).parse(domain)] : [...DOMAINS],
	});
}
