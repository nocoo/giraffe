import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20000 });
const mocked = vi.hoisted(() => ({ execute: vi.fn(), input: vi.fn() }));
vi.mock("node:child_process", async (original) => {
	const actual = await original<typeof import("node:child_process")>();
	const fake = Object.assign(() => {}, {
		[Symbol.for("nodejs.util.promisify.custom")]: (...args: unknown[]) => {
			const promise = mocked.execute(...args) as Promise<{ stdout: string; stderr: string }> & {
				child: { stdin: { end: typeof mocked.input } };
			};
			promise.child = { stdin: { end: mocked.input } };
			return promise;
		},
	});
	return { ...actual, execFile: fake, spawn: vi.fn(actual.spawn) };
});

import { githubRead } from "./github.ts";
import { LocalCleanupError, runLocal } from "./repair-local.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});
it("uses only read-only gh requests and hides upstream failures", async () => {
	mocked.execute.mockResolvedValue({ stdout: "ok", stderr: "sensitive" });
	mocked.execute.mockResolvedValueOnce({ stdout: '{"login":"owner"}', stderr: "" });
	expect(await githubRead("user", new AbortController().signal)).toEqual({ login: "owner" });
	expect(mocked.execute.mock.lastCall?.[1]).toContain("GET");
	mocked.execute.mockRejectedValueOnce(new Error("private"));
	await expect(githubRead("repos/owner/repo")).rejects.toThrow("GitHub read failed");
});
it("stops retaining output after a failed process cleanup without claiming termination", async () => {
	const child = Object.assign(new EventEmitter(), {
		pid: 999999,
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	});
	vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
	vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("fixture denied"), { code: "EPERM" });
	});
	const subarray = vi.spyOn(Buffer.prototype, "subarray");
	const result = runLocal({
		command: "fixture",
		args: [],
		cwd: "/fixture",
		timeoutMs: 1000,
		maxOutputBytes: 1024,
	});
	const rejection = expect(result).rejects.toBeInstanceOf(LocalCleanupError);
	const chunk = Buffer.alloc(2048, "x");
	child.stdout.emit("data", chunk);
	await rejection;
	const captured = subarray.mock.calls.length;
	for (let i = 0; i < 1000; i++) {
		child.stdout.emit("data", chunk);
		child.stderr.emit("data", chunk);
	}
	expect(captured).toBe(1);
	expect(subarray).toHaveBeenCalledTimes(captured);
	child.emit("exit", 1);
	child.emit("close", 1);
	child.removeAllListeners();
	child.stdout.removeAllListeners();
	child.stderr.removeAllListeners();
});
