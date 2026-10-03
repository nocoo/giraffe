import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { configSchema } from "./config.ts";
import { openRuntime } from "./runtime.ts";
import { workConversations } from "./work-conversations.ts";

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
const response = (value: unknown) =>
	fauxAssistantMessage([fauxToolCall("submit_work_result", { json: JSON.stringify(value) })], {
		stopReason: "toolUse",
	});

it("reuses validated controller handoff after reopening SQLite without another model turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "giraffe-result-test-"));
	const models = createModels();
	const fake = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(fake.provider);
	fake.setResponses([response({ summary: "recorded" })]);
	const request = {
		key: "controller",
		requestId: "same",
		role: config.roles.orchestrator,
		instructions: "Plan",
		input: { scope: "one" },
		schema: z.object({ summary: z.string() }),
	};
	try {
		for (let index = 0; index < 2; index++) {
			const runtime = await openRuntime({
				storage: await openNodeSqliteStorage(join(directory, "state.sqlite")),
				models,
			});
			const conversations = workConversations({ runtime, config, log: vi.fn() });
			try {
				if (index === 0) {
					expect(await conversations.checkpoint("new")).toBeNull();
					await conversations.saveCheckpoint("new", '{"ready":true}');
				}
				expect(await conversations.checkpoint("new")).toBe('{"ready":true}');
				expect((await conversations.run(request)).result).toEqual({ summary: "recorded" });
			} finally {
				await conversations.close();
				await runtime.close();
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("reuses resident conversations, isolates dry-run tools and validates handoffs", async () => {
	const models = createModels();
	const fake = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(fake.provider);
	fake.setResponses([
		response({ summary: "first" }),
		response({ summary: "second" }),
		response({ summary: "prep" }),
	]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
	});
	const logs: string[] = [];
	const conversations = workConversations({ runtime, config, log: (line) => logs.push(line) });
	try {
		expect(await conversations.reviewState("run:repo")).toEqual({
			round: 0,
			findings: [],
			head: null,
		});
		await conversations.saveReviewState("run:repo", { round: 3, findings: ["fix"], head: null });
		expect(await conversations.reviewState("run:repo")).toEqual({
			round: 3,
			findings: ["fix"],
			head: null,
		});
		const first = await conversations.run({
			key: "worker:owner/repo",
			requestId: "one",
			role: config.roles.executor,
			instructions: "Rehearse only",
			input: {},
			schema: z.object({ summary: z.string() }),
		});
		const second = await conversations.run({
			key: "worker:owner/repo",
			requestId: "two",
			role: config.roles.executor,
			instructions: "Rehearse only",
			input: {},
			schema: z.object({ summary: z.string() }),
		});
		expect(first.conversationId).toBe(second.conversationId);
		const repeat = await conversations.run({
			key: "worker:owner/repo",
			requestId: "one",
			role: config.roles.executor,
			instructions: "Rehearse only",
			input: {},
			schema: z.object({ summary: z.string() }),
		});
		expect(repeat.result.summary).toBe("first");
		await expect(
			conversations.run({
				key: "worker:owner/repo",
				requestId: "one",
				role: config.roles.executor,
				instructions: "Changed",
				input: {},
				schema: z.object({ summary: z.string() }),
			}),
		).rejects.toThrow("input changed");
		expect(
			(
				await conversations.run({
					key: "preparation",
					requestId: "three",
					role: config.roles.executor,
					instructions: "Prepare plan",
					input: {},
					schema: z.object({ summary: z.string() }),
				})
			).conversationId,
		).not.toBe(first.conversationId);
		expect(logs.join("\n")).toContain("worker:owner/repo");
	} finally {
		await conversations.close();
		await runtime.close();
	}
});

it("gives live roles bounded host actions and fails invalid or unanswered handoffs", async () => {
	const models = createModels();
	const fake = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(fake.provider);
	fake.setResponses([
		response({ summary: "stale success" }),
		fauxAssistantMessage([fauxToolCall("workspace_action", { operation: "check", json: "{}" })], {
			stopReason: "toolUse",
		}),
		response({ summary: "checked" }),
		response({ wrong: true }),
		response({ summary: "corrected" }),
		fauxAssistantMessage([{ type: "text", text: "No structured handoff" }], { stopReason: "stop" }),
	]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
	});
	const log = vi.fn();
	const conversations = workConversations({ runtime, config, log });
	const action = vi.fn(async () => ({ passed: true }));
	const request = {
		key: "controller",
		requestId: "live",
		role: config.roles.orchestrator,
		instructions: "Do checks",
		input: {},
		schema: z.object({ summary: z.string() }),
		action,
	};
	try {
		expect((await conversations.run({ ...request, requiredOperation: "check" })).result).toEqual({
			summary: "checked",
		});
		expect(action).toHaveBeenCalledWith("check", {});
		expect((await conversations.run({ ...request, requestId: "correct" })).result.summary).toBe(
			"corrected",
		);
		await expect(conversations.run({ ...request, requestId: "no-tool" })).rejects.toThrow(
			/validated handoff/,
		);
		fake.setResponses([
			fauxAssistantMessage([fauxToolCall("workspace_action", { operation: "check", json: "{}" })], {
				stopReason: "toolUse",
			}),
			response({ summary: "blocked" }),
		]);
		action.mockRejectedValueOnce(new Error("Baseline changed"));
		expect(
			(await conversations.run({ ...request, requestId: "failed-action" })).result.summary,
		).toBe("blocked");
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Baseline changed"));
	} finally {
		await conversations.close();
		await runtime.close();
	}
});

it("bounds repeated invalid outputs without hanging the coordinator", async () => {
	const models = createModels();
	const fake = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(fake.provider);
	fake.setResponses(Array.from({ length: 26 }, () => response({ invalid: true })));
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
	});
	const conversations = workConversations({ runtime, config, log: vi.fn() });
	try {
		await expect(
			conversations.run({
				key: "worker",
				requestId: "invalid",
				role: config.roles.executor,
				instructions: "Return result",
				input: {},
				schema: z.object({ summary: z.string() }),
			}),
		).rejects.toThrow(/validated handoff/);
	} finally {
		await conversations.close();
		await runtime.close();
	}
});

it("aborts active independent conversations on shutdown and rejects concurrent assignments", async () => {
	let release: () => void = () => {};
	const models = createModels();
	const fake = fauxProvider({ models: [{ id: "astra" }, { id: "sol" }] });
	models.setProvider(fake.provider);
	fake.setResponses([
		fauxAssistantMessage([fauxToolCall("workspace_action", { operation: "wait", json: "{}" })], {
			stopReason: "toolUse",
		}),
	]);
	const runtime = await openRuntime({
		storage: new MemoryStorage(),
		models,
	});
	const log = vi.fn();
	const conversations = workConversations({ runtime, config, log });
	const request = {
		key: "worker:shutdown",
		requestId: "one",
		role: config.roles.executor,
		instructions: "Wait",
		input: {},
		schema: z.object({ summary: z.string() }),
		action: async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return {};
		},
	};
	try {
		const pending = conversations.run(request).catch((error) => error);
		await vi.waitFor(() => expect(log).toHaveBeenCalled());
		await expect(conversations.run({ ...request, requestId: "two" })).rejects.toThrow(
			"active assignment",
		);
		const closing = conversations.close();
		release();
		await closing;
		expect(await pending).toBeInstanceOf(Error);
	} finally {
		await conversations.close();
		await runtime.close();
	}
});
