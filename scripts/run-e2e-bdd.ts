import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const persist = join(root, ".wrangler/e2e-pw");
const tmp = join(root, ".wrangler/e2e-pw-run");
const schema = join(root, "src/server/lib/db/schema.sql");
const wranglerBin = join(root, "node_modules/.bin/wrangler");
const ZERO_KEY = "0".repeat(64);
const workerPort = 27045;
const githubPort = 27046;

function occupyingPid(port: number): string {
	try {
		return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.filter(Boolean)
			.join(",");
	} catch {
		return "unknown";
	}
}

async function assertPortFree(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const server = createServer();
		server.once("error", (err) => {
			const code =
				err && typeof err === "object" && "code" in err
					? String((err as { code: unknown }).code)
					: "";
			if (code === "EADDRINUSE") {
				reject(new Error(`port ${port} already in use (pid ${occupyingPid(port)})`));
				return;
			}
			reject(err);
		});
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolve());
		});
	});
}

function listen(
	port: number,
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const server = createServer(handler);
		server.on("error", reject);
		server.listen(port, "127.0.0.1", () => {
			resolve({
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

const children: ChildProcess[] = [];

function track(child: ChildProcess): void {
	children.push(child);
	child.on("exit", () => {
		const index = children.indexOf(child);
		if (index >= 0) {
			children.splice(index, 1);
		}
	});
}

function run(cmd: string, args: string[], extra: Record<string, string> = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: root,
			env: { ...process.env, ...extra },
			stdio: "inherit",
		});
		track(child);
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${cmd} exited ${code}`));
			}
		});
	});
}

async function waitLive(timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`http://127.0.0.1:${workerPort}/api/live`);
			if (res.ok) {
				const body = (await res.json()) as { d1_marker?: string };
				if (body.d1_marker === "test") {
					return;
				}
			}
		} catch {
			// retry
		}
		await Bun.sleep(200);
	}
	throw new Error("live poll timeout");
}

async function applySchema(config: string): Promise<void> {
	await rm(persist, { recursive: true, force: true });
	await mkdir(persist, { recursive: true });
	await run(wranglerBin, [
		"d1",
		"execute",
		"giraffe-db",
		"--local",
		`--persist-to=${persist}`,
		`--config=${config}`,
		`--file=${schema}`,
	]);
	const marker = join(tmp, "marker.sql");
	await writeFile(
		marker,
		"CREATE TABLE IF NOT EXISTS _test_marker (key TEXT PRIMARY KEY, value TEXT NOT NULL);\nINSERT OR REPLACE INTO _test_marker (key, value) VALUES ('env', 'test');\n",
	);
	await run(wranglerBin, [
		"d1",
		"execute",
		"giraffe-db",
		"--local",
		`--persist-to=${persist}`,
		`--config=${config}`,
		`--file=${marker}`,
	]);
}

function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json");
	for (const [key, value] of Object.entries(headers)) {
		res.setHeader(key, value);
	}
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => {
			chunks.push(chunk as Buffer);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

async function stopWrangler(wrangler: ChildProcess): Promise<void> {
	if (wrangler.exitCode !== null) {
		return;
	}
	wrangler.kill("SIGTERM");
	await Promise.race([
		new Promise<void>((resolve) => {
			wrangler.once("exit", () => resolve());
		}),
		Bun.sleep(1_000),
	]);
	if (wrangler.exitCode === null) {
		wrangler.kill("SIGKILL");
		await new Promise<void>((resolve) => {
			wrangler.once("exit", () => resolve());
		});
	}
}

await assertPortFree(githubPort);
const github = await listen(githubPort, (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${githubPort}`);
	void (async () => {
		const auth = req.headers.authorization ?? "";
		if (url.pathname === "/user") {
			if (auth.includes("B".repeat(8))) {
				sendJson(res, 401, {});
				return;
			}
			sendJson(
				res,
				200,
				{ login: "octocat", avatar_url: "" },
				{ "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
			);
			return;
		}
		if (url.pathname === "/graphql") {
			const raw = await readBody(req);
			const query = String((JSON.parse(raw || "{}") as { query?: string }).query ?? "");
			if (query.includes("viewer")) {
				sendJson(res, 200, {
					data: {
						viewer: {
							repositories: {
								nodes: [
									{
										nameWithOwner: "octocat/hello-world",
										name: "hello-world",
										owner: { login: "octocat" },
										description: "A demo repo",
										stargazerCount: 1,
										forkCount: 0,
										pushedAt: "2026-08-01T00:00:00.000Z",
										issues: { totalCount: 0 },
										url: "https://github.com/octocat/hello-world",
									},
								],
								pageInfo: { hasNextPage: false },
							},
						},
					},
				});
				return;
			}
			sendJson(res, 200, { data: { repository: { vulnerabilityAlerts: { nodes: [] } } } });
			return;
		}
		if (url.pathname === "/repos/octocat/hello-world") {
			sendJson(res, 200, {
				description: "A demo repo",
				default_branch: "main",
				html_url: "https://github.com/octocat/hello-world",
			});
			return;
		}
		sendJson(res, 404, {});
	})().catch(() => {
		res.statusCode = 500;
		res.end("{}");
	});
});

async function shutdown(): Promise<void> {
	for (const child of [...children]) {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
		}
	}
	await Bun.sleep(300);
	for (const child of [...children]) {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
		}
	}
	await github.close();
}

process.once("SIGINT", () => {
	void shutdown().finally(() => process.exit(1));
});
process.once("SIGTERM", () => {
	void shutdown().finally(() => process.exit(1));
});

try {
	await mkdir(tmp, { recursive: true });
	await run(join(root, "node_modules/.bin/vite"), ["build"]);
	const assets = join(tmp, "dist/client");
	await rm(assets, { recursive: true, force: true });
	await cp(join(root, "dist/client"), assets, { recursive: true });
	const configPath = join(tmp, "wrangler.toml");
	const rootToml = await readFile(join(root, "wrangler.toml"), "utf8");
	await writeFile(
		configPath,
		rootToml
			.replaceAll("port = 7045", `port = ${workerPort}`)
			.replaceAll('directory = "./dist/client"', `directory = ${JSON.stringify(assets)}`)
			.replaceAll(
				'main = "src/server/index.ts"',
				`main = ${JSON.stringify(join(root, "src/server/index.ts"))}`,
			),
	);
	const envFile = join(tmp, ".env.A");
	await writeFile(
		envFile,
		[
			"ENVIRONMENT=development",
			"TOKEN_ENCRYPTION_KEY_CURRENT=1",
			`TOKEN_ENCRYPTION_KEY_V1=${ZERO_KEY}`,
			`GITHUB_API_BASE=http://127.0.0.1:${githubPort}`,
			"",
		].join("\n"),
	);
	await applySchema(configPath);
	await assertPortFree(workerPort);
	const logPath = join(tmp, "wrangler-A.log");
	await writeFile(logPath, "");
	const logFd = openSync(logPath, "a");
	const wrangler = spawn(
		wranglerBin,
		[
			"dev",
			"--local",
			"--port",
			String(workerPort),
			`--persist-to=${persist}`,
			`--config=${configPath}`,
			`--env-file=${envFile}`,
		],
		{ cwd: root, stdio: ["ignore", "pipe", "pipe"] },
	);
	track(wrangler);
	wrangler.stdout?.on("data", (chunk) => {
		writeSync(logFd, Uint8Array.from(chunk as Buffer));
		process.stdout.write(chunk);
	});
	wrangler.stderr?.on("data", (chunk) => {
		writeSync(logFd, Uint8Array.from(chunk as Buffer));
		process.stderr.write(chunk);
	});
	try {
		await waitLive(60_000);
		await run(
			join(root, "node_modules/.bin/playwright"),
			["test", "--config", "playwright.config.ts"],
			{
				GIRAFFE_E2E: `http://127.0.0.1:${workerPort}`,
			},
		);
	} finally {
		await stopWrangler(wrangler);
		fsyncSync(logFd);
		closeSync(logFd);
	}
} finally {
	await shutdown();
}
