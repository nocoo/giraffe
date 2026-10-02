import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { configSchema } from "./config.ts";
import type { DependencyPlan, LiveIssue, RepairReview } from "./repair-contracts.ts";
import { repairModels } from "./repair-models.ts";
import { type CheckReceipt, WorkspaceDriver, type WorkspaceSnapshot } from "./repair-workspace.ts";
import { openRuntime } from "./runtime.ts";

const now = "2026-10-02T00:00:00.000Z";
const config = configSchema.parse({
	providers: {
		faux: { api: "openai-completions", baseUrl: "http://localhost:1", apiKey: "test" },
		jev: { api: "typesafe-systemone", baseUrl: "http://localhost:2", apiKey: "test" },
	},
	roles: {
		orchestrator: { provider: "faux", model: "astra" },
		executor: { provider: "faux", model: "sol" },
		decision: { provider: "jev", model: "jev" },
	},
});
const issue: LiveIssue = {
	repository: "owner/repo",
	number: 1,
	title: "Upgrade demo2.0.0",
	url: "https://github.com/owner/repo/issues/1",
	labels: [],
	updatedAt: now,
	sourceVersion: "source",
	fetchedAt: now,
	body: "demo2.0.0",
	state: "open",
	author: "owner",
	baseSha: "a".repeat(40),
	defaultBranch: "main",
	repositoryId: "1",
	verifiedAt: now,
};
const plan: DependencyPlan = {
	decision: "repair",
	reason: "upgrade",
	manifest: "package.json",
	section: "dependencies",
	dependency: "demo",
	targetVersion: "2.0.0",
	provenance: "original",
	provenanceReason: "owner source",
};
const workspace = {
	path: "/fixture",
	branch: "giraffe/deps-1",
	baseSha: issue.baseSha,
	repository: issue.repository,
	id: "deps-1",
};
const snapshot: WorkspaceSnapshot = {
	head: "b".repeat(40),
	tree: "tree",
	baseTree: "base",
	contentFingerprint: "fingerprint",
	diffDigest: "diff",
	changedPaths: ["package.json"],
	diff: "complete diff",
	manifestBeforeAfter: {},
	complete: true,
};
const checks: CheckReceipt = {
	contentFingerprint: "fingerprint",
	validationDigest: "checks",
	commands: ["test"],
	results: [{ command: "test", exitCode: 0, stdout: "passed", stderr: "" }],
};
const review: RepairReview = {
	verdict: "signoff",
	summary: "reviewed",
	findings: [],
	head: snapshot.head,
	contentFingerprint: "fingerprint",
	validationDigest: "checks",
	reviewedRound: 1,
};
const response = (json: unknown) =>
	fauxAssistantMessage([fauxToolCall("submit_repair_result", { json: JSON.stringify(json) })], {
		stopReason: "toolUse",
	});

it("keeps one root controller, unique Sol workers and one independent Astra reviewer", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(faux.provider);
	const roleCalls: string[] = [];
	const responses = [
		response(plan),
		fauxAssistantMessage([fauxToolCall("read_repair_file", { path: "package.json" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			[fauxToolCall("write_repair_file", { path: "src/fix.ts", content: "fixed" })],
			{ stopReason: "toolUse" },
		),
		response({ summary: "fixed" }),
		response(review),
		response({ ...review, reviewedRound: 2 }),
		response({ summary: "again" }),
		response({ summary: "other" }),
	];
	faux.setResponses(
		responses.map((value) => (_context, _options, _state, model) => {
			roleCalls.push(model.id);
			return value;
		}),
	);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: vi.fn(),
		publish: vi.fn(),
	});
	const driver = new WorkspaceDriver({ profiles: {} });
	vi.spyOn(driver, "readFile").mockResolvedValue("manifest");
	const write = vi.spyOn(driver, "writeFile").mockResolvedValue();
	const logs: string[] = [];
	const event = vi.fn(async () => {});
	const sessions = repairModels({
		runtime,
		config,
		driver,
		log: (line) => logs.push(line),
		onEvent: event,
	});
	try {
		expect(await sessions.plan(issue, {}, "deps-1:plan")).toEqual(plan);
		expect(await sessions.plan(issue, {}, "deps-1:plan")).toEqual(plan);
		const worker = await sessions.work({
			issue,
			plan,
			workspace,
			round: 1,
			feedback: "",
			requestId: "deps-1:work:1",
		});
		expect(write).toHaveBeenCalledWith(workspace, "src/fix.ts", "fixed");
		const first = await sessions.review({
			issue,
			plan,
			snapshot,
			checks,
			round: 1,
			requestId: "deps-1:review:1",
		});
		const second = await sessions.review({
			issue,
			plan,
			snapshot,
			checks,
			round: 2,
			requestId: "deps-1:review:2",
		});
		expect(first.conversationId).toBe(second.conversationId);
		expect(first.conversationId).not.toBe(worker.conversationId);
		const again = await sessions.work({
			issue,
			plan,
			workspace,
			round: 2,
			feedback: "review",
			requestId: "deps-1:work:2",
		});
		const other = await sessions.work({
			issue,
			plan,
			workspace: { ...workspace, id: "deps-2" },
			round: 1,
			feedback: "",
			requestId: "deps-2:work:1",
		});
		expect(again.conversationId).toBe(worker.conversationId);
		expect(other.conversationId).not.toBe(worker.conversationId);
		expect(roleCalls).toEqual(["astra", "sol", "sol", "sol", "astra", "astra", "sol", "sol"]);
		expect(logs.join(" ")).toContain("read_repair_file");
		expect(event).toHaveBeenCalled();
	} finally {
		await sessions.close();
		await runtime.close();
	}
});
it("rejects unstructured completion and lets worker repair invalid structured output", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(faux.provider);
	faux.setResponses([
		response({ wrong: true }),
		response({ summary: "corrected" }),
		fauxAssistantMessage("plain text"),
	]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: vi.fn(),
		publish: vi.fn(),
	});
	const sessions = repairModels({
		runtime,
		config,
		driver: new WorkspaceDriver({ profiles: {} }),
		log: vi.fn(),
	});
	try {
		expect(
			(
				await sessions.work({
					issue,
					plan,
					workspace,
					round: 1,
					feedback: "",
					requestId: "d:work:1",
				})
			).summary,
		).toBe("corrected");
		await expect(sessions.plan(issue, {}, "d:plan")).rejects.toThrow(/valid structured/);
	} finally {
		await sessions.close();
		await runtime.close();
	}
});

it("bounds malformed worker tool loops independently of the20review limit", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 20 }, () => response({ notSummary: true })));
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: vi.fn(),
		publish: vi.fn(),
	});
	const sessions = repairModels({
		runtime,
		config,
		driver: new WorkspaceDriver({ profiles: {} }),
		log: vi.fn(),
	});
	try {
		await expect(
			sessions.work({
				issue,
				plan,
				workspace,
				round: 1,
				feedback: "",
				requestId: "bounded:work:1",
			}),
		).rejects.toThrow();
		expect(faux.state.callCount).toBeLessThanOrEqual(12);
	} finally {
		await sessions.close();
		await runtime.close();
	}
});

it("telemetry rejection never abandons an admitted model run or its watchdog", async () => {
	const models = createModels();
	const faux = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(faux.provider);
	faux.setResponses([response({ summary: "fixed despite telemetry outage" })]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
		config,
		decide: vi.fn(),
		publish: vi.fn(),
	});
	const log = vi.fn();
	const sessions = repairModels({
		runtime,
		config,
		driver: new WorkspaceDriver({ profiles: {} }),
		log,
		onEvent: async () => {
			throw new Error("offline");
		},
	});
	try {
		expect(
			(
				await sessions.work({
					issue,
					plan,
					workspace,
					round: 1,
					feedback: "",
					requestId: "telemetry:work:1",
				})
			).summary,
		).toContain("fixed");
		await runtime.harness.waitForIdle(BACKGROUND_CONTEXT);
		expect(log.mock.calls.flat().join(" ")).toContain("超时保护仍有效");
	} finally {
		await sessions.close();
		await runtime.close();
	}
});
