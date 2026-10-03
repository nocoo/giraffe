import { expect, it, vi } from "vitest";
import { WorkTransportError } from "./github.ts";
import { reviewWork } from "./work-review.ts";

function fixture() {
	const state = { round: 0, findings: [] as string[], head: null as string | null };
	return {
		state,
		load: async () => state,
		save: vi.fn(async (value) => Object.assign(state, value)),
		fix: vi.fn(async () => {}),
		check: vi.fn(async () => "head"),
		review: vi.fn(async () => ({ head: "head", findings: [] as string[] })),
	};
}

it("requires passing checks and independent exact-head review", async () => {
	const options = fixture();
	await expect(reviewWork(options)).resolves.toBe("head");
	expect(options.state.round).toBe(1);
	expect(options.review).toHaveBeenCalledWith("head", 1);
});

it("persists findings and retries without resetting rounds", async () => {
	const options = fixture();
	options.state.round = 18;
	options.review.mockResolvedValueOnce({ head: "head", findings: ["fix test cause"] });
	await reviewWork(options);
	expect(options.fix).toHaveBeenLastCalledWith(20, ["fix test cause"]);
	expect(options.state.round).toBe(20);
});

it("failed tests consume a round and exhaustion never signs off", async () => {
	const options = fixture();
	options.check.mockRejectedValue(new Error("tests failed"));
	await expect(reviewWork(options)).rejects.toThrow("20 rounds exhausted");
	expect(options.fix).toHaveBeenCalledTimes(20);
	expect(options.review).not.toHaveBeenCalled();
	await expect(reviewWork(options)).rejects.toThrow("20 rounds exhausted");
	expect(options.fix).toHaveBeenCalledTimes(20);
});

it("rejects stale review and persists safe failures", async () => {
	const options = fixture();
	options.state.round = 19;
	options.review.mockResolvedValue({ head: "other", findings: [] });
	await expect(reviewWork(options)).rejects.toThrow("20 rounds exhausted");
	expect(options.state.findings).toEqual(["Reviewer did not approve the checked HEAD."]);
});

it("consumes interrupted fix/review rounds and respects cancellation", async () => {
	const options = fixture();
	options.state.round = 19;
	options.fix.mockRejectedValue("unsafe error");
	await expect(reviewWork(options)).rejects.toThrow("20 rounds exhausted");
	expect(options.state.findings).toEqual(["Work round failed."]);
	options.state.round = 0;
	await expect(reviewWork({ ...options, signal: AbortSignal.abort() })).rejects.toThrow(
		"cancelled",
	);
	expect(options.state.round).toBe(0);
});

it("rechecks recovered approval without a twenty-first fix", async () => {
	const options = fixture();
	Object.assign(options.state, { round: 20, head: "head" });
	await expect(reviewWork(options)).resolves.toBe("head");
	expect(options.fix).not.toHaveBeenCalled();
	options.check.mockResolvedValue("changed");
	await expect(reviewWork(options)).rejects.toThrow("20 rounds exhausted");
	expect(options.state.head).toBeNull();
});

it("preserves rounds on retryable transport failure rather than exhausting tests", async () => {
	const options = fixture();
	options.fix.mockRejectedValueOnce(new WorkTransportError("offline"));
	await expect(reviewWork(options)).rejects.toThrow("offline");
	expect(options.state.round).toBe(0);
	await expect(reviewWork(options)).resolves.toBe("head");
	expect(options.state.round).toBe(1);
});
