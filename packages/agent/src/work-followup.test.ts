import { expect, it, vi } from "vitest";
import { type FollowUpState, followUp } from "./work-followup.ts";

it("waits ten minutes for each of at most three exact SHA checks across restart", async () => {
	let now = 0;
	const state: FollowUpState = { checks: 0, nextAt: 600000, outcome: "pending", runs: [] };
	const read = vi.fn(async () => ({
		workflow_runs: [
			{ head_sha: "other", status: "completed", conclusion: "success" },
			{ head_sha: "pushed", status: "in_progress", conclusion: null },
		],
	}));
	const options = {
		sha: "pushed",
		state,
		now: () => now,
		wait: vi.fn(async (ms: number) => {
			now += ms;
		}),
		read,
		save: vi.fn(async () => {}),
	};
	await followUp(options);
	expect(read).toHaveBeenCalledTimes(3);
	expect(now).toBe(1800000);
	expect(state.outcome).toBe("timeout");
	expect(state.runs).toHaveLength(1);
	await followUp(options);
	expect(read).toHaveBeenCalledTimes(3);
});

it("records passed, failed and missing evidence truthfully", async () => {
	for (const conclusion of ["success", "failure", null]) {
		const state: FollowUpState = { checks: 0, nextAt: 0, outcome: "pending", runs: [] };
		await followUp({
			sha: "sha",
			state,
			now: () => 0,
			wait: async () => {},
			save: async () => {},
			read: async () => ({
				workflow_runs: conclusion ? [{ head_sha: "sha", status: "completed", conclusion }] : [],
			}),
		});
		expect(state.outcome).toBe(
			conclusion === "success" ? "passed" : conclusion === "failure" ? "failed" : "timeout",
		);
	}
});

it("persists poll consumption before transport and does not duplicate after report failure", async () => {
	const state: FollowUpState = { checks: 2, nextAt: 0, outcome: "pending", runs: [] };
	const read = vi.fn(async () => {
		throw new Error("offline");
	});
	const save = vi.fn(async (_state: FollowUpState) => {});
	await followUp({ sha: "sha", state, now: () => 0, wait: async () => {}, save, read });
	expect(save.mock.calls[0]?.[0]).toMatchObject({ checks: 3 });
	expect(state.outcome).toBe("timeout");
	await followUp({ sha: "sha", state, now: () => 0, wait: async () => {}, save, read });
	expect(read).toHaveBeenCalledTimes(1);
});

it("stops without consuming a check on cancellation", async () => {
	const state: FollowUpState = { checks: 0, nextAt: 600000, outcome: "pending", runs: [] };
	const read = vi.fn();
	await followUp({
		sha: "sha",
		state,
		now: () => 0,
		wait: async () => {},
		save: async () => {},
		read,
		signal: AbortSignal.abort(),
	});
	expect(read).not.toHaveBeenCalled();
});

it("does not consume a poll if cancelled during its injected wait", async () => {
	const controller = new AbortController();
	const state: FollowUpState = { checks: 0, nextAt: 10, outcome: "pending", runs: [] };
	await followUp({
		sha: "sha",
		state,
		now: () => 0,
		wait: async () => {
			controller.abort();
		},
		save: async () => {},
		read: vi.fn(),
		signal: controller.signal,
	});
	expect(state.checks).toBe(0);
});

it("settles consumed third checks and never treats skipped or partial evidence as passing", async () => {
	for (const result of [
		{ workflow_runs: [{ head_sha: "sha", status: "completed", conclusion: "skipped" }] },
		{ workflow_runs: [{ head_sha: "sha", status: "completed", conclusion: "cancelled" }] },
		{
			total_count: 101,
			workflow_runs: [{ head_sha: "sha", status: "completed", conclusion: "success" }],
		},
	]) {
		const state: FollowUpState = { checks: 2, nextAt: 0, outcome: "pending", runs: [] };
		await followUp({
			sha: "sha",
			state,
			now: () => 0,
			wait: async () => {},
			save: async () => {},
			read: async () => result,
		});
		expect(state.outcome).toBe("timeout");
	}
	const state: FollowUpState = { checks: 3, nextAt: 0, outcome: "pending", runs: [] };
	const read = vi.fn();
	await followUp({
		sha: "sha",
		state,
		now: () => 0,
		wait: async () => {},
		save: async () => {},
		read,
	});
	expect(state.outcome).toBe("timeout");
	expect(read).not.toHaveBeenCalled();
});
