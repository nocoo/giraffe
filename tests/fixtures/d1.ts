import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

type FixtureContext = { persist: string; config: string; root?: string };

function invocation(sql: string, context: FixtureContext) {
	const root = resolve(context.root ?? process.cwd());
	if (
		resolve(context.persist) !== resolve(root, ".wrangler/e2e") ||
		resolve(context.config) !== resolve(root, ".wrangler/e2e-run/wrangler.toml")
	)
		throw new Error("dedicated local L2 runner context required");
	return {
		bin: resolve(root, "node_modules/.bin/wrangler"),
		args: [
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
		options: { cwd: root, encoding: "utf8" as const, timeout: 15_000 },
	};
}

function isBusy(output: string): boolean {
	let text: unknown;
	try {
		text = (JSON.parse(output) as { error?: { text?: unknown } } | null)?.error?.text;
	} catch {
		text = output;
	}
	return (
		typeof text === "string" &&
		/^\s*(?:(?:Error|D1_ERROR):\s*)?(?:database is locked(?::\s*SQLITE_BUSY)?|SQLITE_BUSY)\s*$/im.test(
			text,
		)
	);
}

function retryDelay(error: unknown, attempt: number): number {
	const failure = (error ?? {}) as {
		code?: unknown;
		status?: unknown;
		stdout?: unknown;
		stderr?: unknown;
		signal?: unknown;
		killed?: boolean;
	};
	const exit = failure.status ?? failure.code ?? "unknown";
	const stdout = String(failure.stdout ?? "");
	const stderr = String(failure.stderr ?? "");
	const diagnostic = new Error(
		`local D1 fixture failed (attempt ${attempt}/4, exit ${exit})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
	);
	const delay = [100, 250, 500][attempt - 1];
	if (
		delay === undefined ||
		exit !== 1 ||
		failure.signal ||
		failure.killed ||
		!(isBusy(stdout) || isBusy(stderr))
	)
		throw diagnostic;
	console.warn(`${diagnostic.message}\nretrying local D1 fixture in ${delay}ms`);
	return delay;
}

export function executeD1FixtureSync(sql: string, context: FixtureContext): string {
	const { bin, args, options } = invocation(sql, context);
	for (let attempt = 1; ; attempt++) {
		try {
			return execFileSync(bin, args, { ...options, stdio: "pipe" });
		} catch (error) {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelay(error, attempt));
		}
	}
}

export async function executeD1Fixture(sql: string, context: FixtureContext): Promise<string> {
	const { bin, args, options } = invocation(sql, context);
	for (let attempt = 1; ; attempt++) {
		try {
			return await new Promise<string>((resolve, reject) => {
				execFile(bin, args, options, (error, stdout, stderr) => {
					if (error) reject(Object.assign(error, { stdout, stderr }));
					else resolve(stdout);
				});
			});
		} catch (error) {
			await sleep(retryDelay(error, attempt));
		}
	}
}
