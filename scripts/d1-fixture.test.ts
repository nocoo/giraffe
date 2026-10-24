import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeD1Fixture, executeD1FixtureSync } from "../tests/fixtures/d1";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), sleep: vi.fn() }));
vi.mock("node:child_process", () => ({
	execFileSync: mocks.execute,
	execFile: (
		bin: string,
		args: string[],
		options: unknown,
		callback: (error: Error | null, stdout: string, stderr: string) => void,
	) => {
		try {
			callback(null, mocks.execute(bin, args, options), "");
		} catch (error) {
			const failure = error as Error & { stdout?: string; stderr?: string };
			callback(failure, failure.stdout ?? "", failure.stderr ?? "");
		}
	},
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.sleep }));

const context = {
	persist: resolve(".wrangler/e2e"),
	config: resolve(".wrangler/e2e-run/wrangler.toml"),
};
const output = JSON.stringify([{ results: [{ value: "test" }], success: true }]);
const busy = (stdout = '{"error":{"text":"database is locked: SQLITE_BUSY"}}', stderr = "") =>
	Object.assign(new Error("Command failed: secret fixture SQL"), { status: 1, stdout, stderr });

beforeEach(() => {
	mocks.execute.mockReset().mockReturnValue(output);
	mocks.sleep.mockReset().mockResolvedValue(undefined);
	vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
		mocks.sleep(timeout);
		return "timed-out";
	});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each([
	["sync", executeD1FixtureSync],
	["async", executeD1Fixture],
] as const)("%s local D1 fixtures", (_mode, execute) => {
	it("keeps SQL and JSON intact, uses local-only paths and bounds subprocess time", async () => {
		const sql = "SELECT value FROM _test_marker WHERE key='env'";
		expect(await execute(sql, context)).toBe(output);
		expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(
			resolve("node_modules/.bin/wrangler"),
			[
				"d1",
				"execute",
				"giraffe-db",
				"--local",
				`--persist-to=${context.persist}`,
				`--config=${context.config}`,
				"--json",
				"--command",
				sql,
			],
			expect.objectContaining({ cwd: process.cwd(), encoding: "utf8", timeout: 15_000 }),
		);
		expect(mocks.sleep).not.toHaveBeenCalled();
	});

	it.each([
		["JSON stdout", '{"error":{"text":"database is locked: SQLITE_BUSY"}}', ""],
		["stderr", "", "Error: database is locked"],
		["SQLite code", "", "SQLITE_BUSY"],
	])("retries %s with bounded backoff", async (_label, stdout, stderr) => {
		mocks.execute.mockImplementationOnce(() => {
			throw busy(stdout, stderr);
		});
		expect(await execute("INSERT INTO fixture VALUES(1)", context)).toBe(output);
		expect(mocks.execute).toHaveBeenCalledTimes(2);
		expect(mocks.execute.mock.calls[0]).toEqual(mocks.execute.mock.calls[1]);
		expect(mocks.sleep.mock.calls).toEqual([[100]]);
	});

	it("fails after four busy attempts and retains stdout/stderr diagnostics without SQL", async () => {
		mocks.execute.mockImplementation(() => {
			throw busy(undefined, "fixture stderr detail");
		});
		const result = Promise.resolve().then(() => execute("secret fixture SQL", context));
		await expect(result).rejects.toThrow("attempt 4/4");
		await expect(result).rejects.toThrow(
			'stdout:\n{"error":{"text":"database is locked: SQLITE_BUSY"}}',
		);
		await expect(result).rejects.toThrow("stderr:\nfixture stderr detail");
		await expect(result).rejects.not.toThrow("secret fixture SQL");
		expect(mocks.execute).toHaveBeenCalledTimes(4);
		expect(mocks.sleep.mock.calls).toEqual([[100], [250], [500]]);
	});

	it.each([
		["constraint", '{"error":{"text":"UNIQUE constraint failed: fixture.id"}}', ""],
		["syntax", '{"error":{"text":"near INSERT: syntax error"}}', ""],
		["missing table", '{"error":{"text":"no such table: fixture"}}', ""],
		["network", "", "ECONNRESET"],
		["other lock", "", "SQLITE_LOCKED"],
		["busy table name", '{"error":{"text":"no such table: SQLITE_BUSY"}}', ""],
		["busy literal", '{"error":{"text":"near database is locked: syntax error"}}', ""],
		["absent diagnostics", "", ""],
	])("never retries %s errors or matches the echoed command", async (_label, stdout, stderr) => {
		mocks.execute.mockImplementation(() => {
			throw Object.assign(new Error("Command failed: SELECT 'SQLITE_BUSY'"), {
				code: 1,
				stdout,
				stderr,
			});
		});
		await expect(
			Promise.resolve().then(() => execute("SELECT 'SQLITE_BUSY'", context)),
		).rejects.toThrow(`exit 1)\nstdout:\n${stdout}\nstderr:\n${stderr}`);
		expect(mocks.execute).toHaveBeenCalledTimes(1);
		expect(mocks.sleep).not.toHaveBeenCalled();
	});

	it("does not retry JSON decoding or assertions after successful execution", async () => {
		mocks.execute.mockReturnValue("not JSON");
		await expect(
			Promise.resolve().then(async () => JSON.parse(await execute("SELECT 1", context))),
		).rejects.toThrow();
		expect(mocks.execute).toHaveBeenCalledTimes(1);
		expect(mocks.sleep).not.toHaveBeenCalled();
	});

	it("stops immediately if a later attempt fails for a different reason", async () => {
		mocks.execute
			.mockImplementationOnce(() => {
				throw busy();
			})
			.mockImplementationOnce(() => {
				throw busy('{"error":{"text":"UNIQUE constraint failed"}}');
			});
		await expect(Promise.resolve().then(() => execute("INSERT", context))).rejects.toThrow(
			"UNIQUE constraint failed",
		);
		expect(mocks.execute).toHaveBeenCalledTimes(2);
		expect(mocks.sleep.mock.calls).toEqual([[100]]);
	});

	it.each([{ code: "ETIMEDOUT", status: null }, { killed: true }, { signal: "SIGTERM" }])(
		"never retries interrupted processes even with busy output",
		async (interrupted) => {
			mocks.execute.mockImplementation(() => {
				throw Object.assign(busy(), interrupted);
			});
			await expect(Promise.resolve().then(() => execute("INSERT", context))).rejects.toThrow(
				"local D1 fixture failed",
			);
			expect(mocks.execute).toHaveBeenCalledTimes(1);
			expect(mocks.sleep).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ ...context, persist: resolve(".wrangler/state") },
		{ ...context, config: resolve("wrangler.toml") },
	])("rejects non-L2 context before execution", async (invalid) => {
		await expect(
			Promise.resolve().then(() => execute("DELETE FROM fixture", invalid)),
		).rejects.toThrow("dedicated local L2 runner context required");
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.sleep).not.toHaveBeenCalled();
	});
});
