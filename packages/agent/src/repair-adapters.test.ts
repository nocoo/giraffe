import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { hostGitTransport, LocalCleanupError, runLocal } from "./repair-local.ts";
import { githubRead } from "./repair-source.ts";

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
it("restricts host Git commands and never exposes transport stderr", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "giraffe-transport-"));
	try {
		await writeFile(
			join(cwd, "git"),
			"#!/bin/sh\nprintf '%s' \"$*\"\nprintf private >&2\nexit 7\n",
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", cwd);
		const request = {
			operation: "remoteHead" as const,
			repository: "fixture/repo",
			cwd,
			timeoutMs: 10000,
			maxOutputBytes: 4096,
		};
		for (const command of [
			{ command: "sh", args: [] },
			{ command: "git", args: [] },
			{ command: "git", args: ["reset"] },
		])
			await expect(hostGitTransport({ ...request, command })).rejects.toThrow(/Unsupported/);
		const result = await hostGitTransport({
			...request,
			command: { command: "git", args: ["ls-remote", "fixture"] },
			signal: new AbortController().signal,
		});
		expect(result).toMatchObject({ exitCode: 7, stderr: "" });
		expect(result.stdout).toContain("credential.helper=!gh auth git-credential");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
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
