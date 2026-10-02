import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Collection, GiraffeClient } from "./client.ts";
import { type Credential, configSchema } from "./config.ts";
import { type AnalysisReport, DOMAINS, type Domain, type Resource } from "./contracts.ts";
import { type AnalysisInput, buildInput } from "./evidence.ts";
import type { AgentRuntime } from "./runtime.ts";
import { createWatcher, parseAnalysisTarget, reportInput } from "./watch.ts";

const now = "2026-10-02T10:00:00.000Z";
const config = configSchema.parse({
	providers: {
		models: {
			api: "openai-completions",
			baseUrl: "http://localhost:1",
			apiKey: "test",
		},
		decision: {
			api: "typesafe-systemone",
			baseUrl: "http://localhost:2",
			apiKey: "test",
		},
	},
	roles: {
		orchestrator: { provider: "models", model: "planner" },
		decision: { provider: "decision", model: "jev" },
		executor: { provider: "models", model: "worker" },
	},
	watch: { intervalSeconds: 30 },
});
const credential: Credential = {
	baseUrl: "https://example.test",
	token: "test",
	account_id: "account",
	scopes: [],
	expires_at: "2099-01-01T00:00:00.000Z",
};
const request = {
	scope: "repo" as const,
	repository: "owner/repo",
	domains: ["issues" as const],
};
const input = (repository: string, domain: Domain) => buildInput(repository, domain, [], now);
const row = (value: Partial<Resource> & Pick<Resource, "id">): Resource => ({
	account_id: "account",
	repository: null,
	type: "github-analysis",
	status: "pending",
	source_version: null,
	payload: {},
	revision: 1,
	created_at: now,
	updated_at: now,
	...value,
});
const report = (entry: AnalysisInput): AnalysisReport => ({
	schemaVersion: 1,
	scope: entry.scope,
	repository: entry.repository,
	domain: entry.domain,
	sourceVersion: entry.sourceVersion,
	observedAt: now,
	generatedAt: now,
	verdict: "unknown",
	summary: "No complete data.",
	findings: [],
	actions: [],
	limitations: [],
	sources: entry.sources,
	evidence: [],
	omitted: 0,
	judgment: {
		model: "jev",
		choice: "unknown",
		confidence: 1,
		probabilities: { unknown: 1, urgent: 0, review: 0, routine: 0 },
	},
	producer: {
		orchestrator: "planner",
		executor: "worker",
		decision: "jev",
		conversationId: 1,
		jobId: "test",
	},
});
function fixture() {
	const data: Record<Collection, Map<string, Resource>> = {
		records: new Map(),
		reports: new Map(),
		jobs: new Map(),
	};
	const client = new GiraffeClient(credential);
	vi.spyOn(client, "me").mockResolvedValue({
		account_id: "account",
		login: "owner",
		token: { id: "token", expires_at: credential.expires_at, scopes: [] },
	});
	vi.spyOn(client, "observation").mockResolvedValue({
		account_id: "account",
		data: { repos: [{ name_with_owner: "owner/repo", owner_login: "owner" }] },
		sourceVersion: "catalog",
		fetchedAt: now,
		freshness: null,
		coverage: null,
		truncated: false,
		unavailable: false,
		source: { resource: "repos", kind: "snapshot", publicationId: null },
		selection: { scope: "all", statisticsFilter: false },
	});
	vi.spyOn(client, "get").mockImplementation(
		async (collection, id) => data[collection].get(id) ?? null,
	);
	vi.spyOn(client, "list").mockImplementation(async (collection, filters = {}) =>
		[...data[collection].values()].filter((item) =>
			Object.entries(filters).every(([key, value]) => item[key as keyof Resource] === value),
		),
	);
	vi.spyOn(client, "create").mockImplementation(async (collection, value) => {
		const existing = data[collection].get(value.id);
		if (existing) return existing;
		const created = row(value);
		data[collection].set(created.id, created);
		return created;
	});
	const update = vi
		.spyOn(client, "update")
		.mockImplementation(async (collection, existing, patch) => {
			const latest = data[collection].get(existing.id);
			if (latest && latest.revision !== existing.revision)
				throw new ApiError(409, "revision_conflict");
			const updated = {
				...existing,
				...patch,
				revision: existing.revision + 1,
			};
			data[collection].set(updated.id, updated);
			return updated;
		});
	const saved = new Map<string, { inputs: AnalysisInput[] }>();
	const run = vi.fn(async (_id: string, inputs: AnalysisInput[]) => inputs.map(report));
	const pending = vi.fn(async () => [] as string[]);
	const runtime = {
		run,
		job: vi.fn(async (id: string) => saved.get(id) ?? null),
		pending,
		closing: false,
	} as unknown as AgentRuntime;
	const collect = vi.fn(async (_client: GiraffeClient, repository: string, domain: Domain) =>
		input(repository, domain),
	);
	const logs: string[] = [];
	const watcher = createWatcher({
		client,
		runtime,
		config,
		version: "test",
		runnerId: "test-runner",
		now: () => now,
		log: (line) => logs.push(line),
		collect,
	});
	return {
		data,
		client,
		runtime,
		saved,
		run,
		pending,
		collect,
		update,
		logs,
		watcher,
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("watch service", () => {
	it("analyzes once, publishes a heartbeat and avoids unchanged jobs", async () => {
		const f = fixture();
		await f.watcher.once(request);
		expect(f.run).toHaveBeenCalledOnce();
		expect([...f.data.jobs.values()][0]?.status).toBe("completed");
		expect(f.data.records.get("test-runner")?.payload).toMatchObject({
			state: "idle",
			currentJob: null,
		});
		await f.watcher.once(request);
		expect(f.run).toHaveBeenCalledOnce();
		expect(reportInput("report", report(input("owner/repo", "issues")))).toMatchObject({
			id: "report",
			status: "completed",
		});
	});
	it("runs all four repo domains followed by global domains", async () => {
		const f = fixture();
		await f.watcher.once();
		expect(f.collect).toHaveBeenCalledTimes(4);
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(f.run.mock.calls[1]?.[1].map((item) => item.domain)).toEqual([...DOMAINS]);
		expect(f.run.mock.calls[1]?.[1][0]?.scope).toBe("global");
		expect(parseAnalysisTarget("owner/repo", "ci")).toMatchObject({
			scope: "repo",
			domains: ["ci"],
		});
		expect(parseAnalysisTarget(undefined, undefined).scope).toBe("global");
		expect(() => parseAnalysisTarget("invalid", "ci")).toThrow();
	});
	it("claims web requests and records invalid or out-of-scope failures", async () => {
		const f = fixture();
		f.data.jobs.set("bad", row({ id: "bad", type: "analysis-request", payload: {} }));
		f.data.jobs.set(
			"outside",
			row({
				id: "outside",
				type: "analysis-request",
				payload: { ...request, repository: "other/repo" },
			}),
		);
		f.data.jobs.set("web", row({ id: "web", type: "analysis-request", payload: request }));
		await f.watcher.once(request);
		expect(f.data.jobs.get("bad")?.payload.error).toBe("invalid_analysis_request");
		expect(f.data.jobs.get("outside")?.status).toBe("failed");
		expect(f.data.jobs.get("web")?.status).toBe("completed");
		expect(f.run).toHaveBeenCalledTimes(2);
	});
	it("recovers durable input and already claimed web jobs after restart", async () => {
		const f = fixture();
		f.pending.mockResolvedValue(["saved"]);
		f.saved.set("saved", { inputs: [input("owner/repo", "issues")] });
		f.data.jobs.set(
			"web",
			row({
				id: "web",
				type: "analysis-request",
				status: "running",
				payload: { ...request, runnerId: "test-runner" },
			}),
		);
		await f.watcher.once(request);
		expect(f.run.mock.calls[0]?.[0]).toBe("saved");
		expect(f.data.jobs.get("web")?.status).toBe("completed");
	});
	it("records analysis failures but preserves pending work during shutdown", async () => {
		const f = fixture();
		f.run.mockRejectedValue(new Error("model failed"));
		await expect(f.watcher.once(request)).rejects.toThrow("model failed");
		expect([...f.data.jobs.values()][0]?.status).toBe("failed");
		await expect(f.watcher.once(request)).rejects.toThrow(/already ended/);
		await expect(f.watcher.once({ ...request, repository: "other/repo" })).rejects.toThrow(
			/outside/,
		);
		const g = fixture();
		g.run.mockImplementation(async () => {
			Object.defineProperty(g.runtime, "closing", { value: true });
			throw new Error("closed");
		});
		await expect(g.watcher.once(request)).rejects.toThrow("closed");
		expect([...g.data.jobs.values()][0]?.status).toBe("running");
		await g.watcher.once();
		expect(g.run).toHaveBeenCalledOnce();
	});
	it("skips a competing claim and does not hide a non-conflict request error", async () => {
		const f = fixture();
		f.data.jobs.set("web", row({ id: "web", type: "analysis-request", payload: request }));
		f.update.mockImplementationOnce(async () => {
			throw new ApiError(409, "revision_conflict");
		});
		await f.watcher.once(request);
		expect(f.data.jobs.get("web")?.status).toBe("pending");
		f.update.mockRejectedValueOnce(new ApiError(500, "failure"));
		await expect(f.watcher.once(request)).rejects.toThrow(/500/);
	});
	it("keeps polling after failure and reports offline on cancellation", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const controller = new AbortController();
		vi.spyOn(f.watcher, "once").mockImplementation(async () => {
			controller.abort();
			throw new Error("failed");
		});
		await f.watcher.watch(controller.signal);
		expect(f.logs.join(" ")).toContain("观察失败");
		expect(f.data.records.get("test-runner")?.status).toBe("offline");
	});
	it("does not run when already aborted", async () => {
		const f = fixture();
		await f.watcher.watch(AbortSignal.abort());
		expect(f.run).not.toHaveBeenCalled();
		expect(f.data.records.get("test-runner")?.status).toBe("offline");
	});

	it("uses default runner identity, logger, collector and clock without hidden model work", async () => {
		const f = fixture();
		const watcher = createWatcher({
			client: f.client,
			runtime: f.runtime,
			config,
			version: "test",
		});
		await watcher.heartbeat("error");
		const presence = [...f.data.records.values()][0];
		expect(presence?.id).toMatch(/^runner-/);
		expect(presence?.payload.lastSeenAt).toBeTruthy();
		await watcher.once({
			scope: "global",
			repository: null,
			domains: ["issues"],
		});
	});

	it("rejects non-conflict claim failures without consuming the web request", async () => {
		const f = fixture();
		f.data.jobs.set("web", row({ id: "web", type: "analysis-request", payload: request }));
		const normal = f.update.getMockImplementation();
		f.update.mockImplementation(async (collection, existing, patch) => {
			if (existing.id === "web") throw new ApiError(500, "failure");
			if (!normal) throw new Error("test fixture");
			return normal(collection, existing, patch);
		});
		await expect(f.watcher.once(request)).rejects.toThrow(/500/);
		expect(f.data.jobs.get("web")?.status).toBe("pending");
	});

	it("keeps a visible heartbeat during a long analysis and cancels idle waiting", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const controller = new AbortController();
		let finish: () => void = () => {};
		vi.spyOn(f.watcher, "once").mockImplementation(
			async () =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const watching = f.watcher.watch(controller.signal);
		await vi.advanceTimersByTimeAsync(30000);
		expect(f.data.records.get("test-runner")?.status).toBe("idle");
		finish();
		await Promise.resolve();
		controller.abort();
		await watching;
		expect(f.data.records.get("test-runner")?.status).toBe("offline");
	});

	it("handles heartbeat transport errors without losing the watch loop", async () => {
		vi.useFakeTimers();
		const f = fixture();
		const controller = new AbortController();
		let finish: () => void = () => {};
		vi.spyOn(f.watcher, "once").mockImplementation(
			async () =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		vi.mocked(f.client.get).mockRejectedValue(new Error("offline"));
		const watching = f.watcher.watch(controller.signal);
		await vi.advanceTimersByTimeAsync(30000);
		controller.abort();
		finish();
		await watching;
		expect(f.logs.join(" ")).toContain("心跳失败");
	});

	it("continues to global reports when a repository analysis fails", async () => {
		const f = fixture();
		f.run.mockRejectedValueOnce(new Error("repo failed"));
		await f.watcher.once();
		expect(f.run).toHaveBeenCalledTimes(2);
		expect(f.logs.join(" ")).toContain("旧报告保留");
	});

	it("uses saved request evidence and handles cancellation without marking success", async () => {
		const f = fixture();
		f.data.jobs.set("web", row({ id: "web", type: "analysis-request", payload: request }));
		vi.mocked(f.runtime.job).mockImplementation(async (id) =>
			id.startsWith("request-")
				? ({ id, inputs: [input("owner/repo", "issues")] } as NonNullable<
						Awaited<ReturnType<AgentRuntime["job"]>>
					>)
				: undefined,
		);
		await f.watcher.once(request);
		expect(f.collect).toHaveBeenCalledTimes(1);
		const g = fixture();
		g.data.jobs.set("web", row({ id: "web", type: "analysis-request", payload: request }));
		g.run.mockImplementation(async () => {
			Object.defineProperty(g.runtime, "closing", { value: true });
			throw new Error("closing");
		});
		await g.watcher.once();
		expect(g.data.jobs.get("web")?.status).toBe("running");
	});

	it("leaves unclaimed requests pending when shutdown starts during the read", async () => {
		const f = fixture();
		const list = vi.mocked(f.client.list).getMockImplementation();
		vi.mocked(f.client.list).mockImplementation(async (collection, filters) => {
			if (collection === "jobs") {
				Object.defineProperty(f.runtime, "closing", { value: true });
				return [row({ id: "late", type: "analysis-request", payload: request })];
			}
			return list ? list(collection, filters) : [];
		});
		await f.watcher.once();
		expect(f.run).not.toHaveBeenCalled();
		expect(f.update.mock.calls.some((call) => call[1].id === "late")).toBe(false);
	});
});
