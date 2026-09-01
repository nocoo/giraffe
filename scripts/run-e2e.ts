import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasApiRoutes } from "./has-api-routes";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const persist = join(root, ".wrangler/e2e");
const schema = join(root, "src/server/lib/db/schema.sql");
const wranglerBin = join(root, "node_modules/.bin/wrangler");
const ZERO_KEY = "0".repeat(64);

if (!(await hasApiRoutes())) {
	console.log("L2 N/A: no /api routes yet");
	process.exit(0);
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

async function waitLive(timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch("http://127.0.0.1:17045/api/live");
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

function run(cmd: string, args: string[], extra: Record<string, string> = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: root,
			env: { ...process.env, ...extra },
			stdio: "inherit",
		});
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${cmd} exited ${code}`));
			}
		});
	});
}

async function applySchema(): Promise<void> {
	await rm(persist, { recursive: true, force: true });
	await mkdir(persist, { recursive: true });
	await run(wranglerBin, [
		"d1",
		"execute",
		"giraffe-db",
		"--local",
		`--persist-to=${persist}`,
		`--file=${schema}`,
	]);
	const marker = join(root, ".wrangler/e2e-run/marker.sql");
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
		`--file=${marker}`,
	]);
}

async function suite(name: "A" | "B"): Promise<void> {
	const tmp = join(root, ".wrangler/e2e-run");
	await mkdir(join(tmp, "dist/client"), { recursive: true });
	await writeFile(
		join(tmp, "wrangler.toml"),
		`name = "giraffe"
main = ${JSON.stringify(join(root, "src/server/index.ts"))}
compatibility_date = "2026-04-01"
workers_dev = false
preview_urls = false
[dev]
port = 17045
[assets]
directory = ${JSON.stringify(join(tmp, "dist/client"))}
binding = "ASSETS"
run_worker_first = ["/api/*"]
not_found_handling = "single-page-application"
[[d1_databases]]
binding = "DB"
database_name = "giraffe-db"
database_id = "00000000-0000-4000-8000-000000000001"
`,
	);
	await writeFile(join(tmp, "dist/client/index.html"), "<!doctype html><title>giraffe</title>\n");
	const envFile = join(tmp, `.env.${name}`);
	const lines = [
		"TOKEN_ENCRYPTION_KEY_CURRENT=1",
		`TOKEN_ENCRYPTION_KEY_V1=${ZERO_KEY}`,
		"GITHUB_API_BASE=http://127.0.0.1:17046",
	];
	if (name === "A") {
		lines.unshift("ENVIRONMENT=development");
	} else {
		lines.unshift("ENVIRONMENT=test");
		lines.push("CF_ACCESS_TEAM_DOMAIN=http://127.0.0.1:17047");
		lines.push("CF_ACCESS_AUD=giraffe-e2e");
		lines.push("ACCESS_JWKS_URL=http://127.0.0.1:17047/cdn-cgi/access/certs");
	}
	await writeFile(envFile, `${lines.join("\n")}\n`);
	await applySchema();
	const wrangler = spawn(
		wranglerBin,
		[
			"dev",
			"--local",
			"--port",
			"17045",
			`--persist-to=${persist}`,
			`--config=${join(tmp, "wrangler.toml")}`,
			`--env-file=${envFile}`,
		],
		{ cwd: root, stdio: "inherit" },
	);
	try {
		await waitLive(60_000);
		await run(
			join(root, "node_modules/.bin/vitest"),
			["run", "tests/api", "--config", "vitest.e2e.config.ts"],
			{
				GIRAFFE_SUITE: name,
				GIRAFFE_E2E: "http://127.0.0.1:17045",
			},
		);
	} finally {
		wrangler.kill("SIGTERM");
		await Bun.sleep(300);
		if (wrangler.exitCode === null) {
			wrangler.kill("SIGKILL");
		}
	}
}

const github = await listen(17046, (_req, res) => {
	res.statusCode = 404;
	res.end("{}");
});
const jwks = await listen(17047, (req, res) => {
	if (req.url?.includes("/cdn-cgi/access/certs")) {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ keys: [] }));
		return;
	}
	res.statusCode = 404;
	res.end();
});

try {
	await mkdir(join(root, ".wrangler/e2e-run"), { recursive: true });
	await suite("A");
	await suite("B");
} finally {
	await github.close();
	await jwks.close();
}
