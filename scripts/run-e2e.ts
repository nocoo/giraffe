import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
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
const tokens = { jwt: "", jwtBadAud: "", jwtBadSig: "" };

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
	await assertPortFree(17045);
	const logPath = join(tmp, `wrangler-${name}.log`);
	await writeFile(logPath, "");
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
		{ cwd: root, stdio: ["ignore", "pipe", "pipe"] },
	);
	const logStream = createWriteStream(logPath, { flags: "a" });
	wrangler.stdout?.on("data", (chunk) => {
		logStream.write(chunk);
		process.stdout.write(chunk);
	});
	wrangler.stderr?.on("data", (chunk) => {
		logStream.write(chunk);
		process.stderr.write(chunk);
	});
	try {
		await waitLive(60_000);
		await run(
			join(root, "node_modules/.bin/vitest"),
			["run", "tests/api", "--config", "vitest.e2e.config.ts"],
			{
				GIRAFFE_SUITE: name,
				GIRAFFE_E2E: "http://127.0.0.1:17045",
				GIRAFFE_JWT: tokens.jwt,
				GIRAFFE_JWT_BAD_AUD: tokens.jwtBadAud,
				GIRAFFE_JWT_BAD_SIG: tokens.jwtBadSig,
				GIRAFFE_WRANGLER_LOG: logPath,
				GIRAFFE_PERSIST: persist,
				GIRAFFE_CONFIG: join(tmp, "wrangler.toml"),
			},
		);
	} finally {
		wrangler.kill("SIGTERM");
		await Bun.sleep(300);
		if (wrangler.exitCode === null) {
			wrangler.kill("SIGKILL");
		}
		logStream.end();
	}
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

let githubHits = 0;
await assertPortFree(17046);
const github = await listen(17046, (req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1:17046");
	if (url.pathname === "/_count") {
		res.end(String(githubHits));
		return;
	}
	if (url.pathname === "/_reset") {
		githubHits = 0;
		res.end("0");
		return;
	}
	githubHits += 1;
	void (async () => {
		const auth = req.headers.authorization ?? "";
		if (url.pathname === "/user") {
			if (auth.includes("B".repeat(8))) {
				sendJson(res, 401, {});
				return;
			}
			if (auth.includes("D".repeat(8))) {
				sendJson(
					res,
					200,
					{ login: "hubot", avatar_url: "" },
					{ "X-OAuth-Scopes": "repo, read:org, read:user, notifications" },
				);
				return;
			}
			const scopes = auth.includes("C".repeat(8))
				? "repo"
				: "repo, read:org, read:user, notifications";
			sendJson(res, 200, { login: "octocat", avatar_url: "" }, { "X-OAuth-Scopes": scopes });
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
										stargazerCount: 1,
										forkCount: 0,
										pushedAt: "2026-08-01T00:00:00.000Z",
										issues: { totalCount: 0 },
									},
								],
								pageInfo: { hasNextPage: false },
							},
						},
					},
				});
				return;
			}
			if (query.includes("search")) {
				sendJson(res, 200, {
					data: { search: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } } },
				});
				return;
			}
			sendJson(res, 200, {
				data: { repository: { vulnerabilityAlerts: { nodes: [] } } },
			});
			return;
		}
		if (req.method === "PATCH" && url.pathname.startsWith("/notifications/threads/")) {
			res.statusCode = 205;
			res.end();
			return;
		}
		if (req.method === "PUT" && url.pathname === "/notifications") {
			res.statusCode = 205;
			res.end();
			return;
		}
		if (url.pathname === "/notifications") {
			sendJson(res, 200, [
				{
					id: "123",
					unread: true,
					reason: "mention",
					updated_at: "2026-09-01T00:00:00.000Z",
					subject: { title: "hello", url: "https://github.com" },
					repository: { full_name: "octocat/hello-world" },
				},
			]);
			return;
		}
		if (
			url.pathname.includes("/code-scanning/alerts") ||
			url.pathname.endsWith("/releases") ||
			url.pathname.endsWith("/contributors")
		) {
			sendJson(res, 200, []);
			return;
		}
		if (url.pathname.includes("/actions/runs")) {
			sendJson(res, 200, { workflow_runs: [] });
			return;
		}
		if (url.pathname.includes("/traffic/")) {
			sendJson(res, 200, { count: 0, uniques: 0, views: [], clones: [] });
			return;
		}
		if (url.pathname.endsWith("/languages")) {
			sendJson(res, 200, { TypeScript: 1 });
			return;
		}
		if (url.pathname === "/repos/octocat/hello-world") {
			sendJson(res, 200, {
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

function b64url(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) {
		s += String.fromCharCode(b);
	}
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const pair = (await crypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: 2048,
		publicExponent: new Uint8Array([1, 0, 1]),
		hash: "SHA-256",
	},
	true,
	["sign", "verify"],
)) as CryptoKeyPair;
const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown> & {
	kid?: string;
};
jwk.kid = "e2e";
jwk.alg = "RS256";
jwk.use = "sig";

async function signJwt(payload: Record<string, unknown>): Promise<string> {
	const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: "e2e" })));
	const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
	const sig = new Uint8Array(
		await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			pair.privateKey,
			new TextEncoder().encode(`${header}.${body}`),
		),
	);
	return `${header}.${body}.${b64url(sig)}`;
}

const now = Math.floor(Date.now() / 1000);
tokens.jwt = await signJwt({
	iss: "http://127.0.0.1:17047",
	aud: "giraffe-e2e",
	exp: now + 3600,
	email: "e2e@local",
	name: "e2e",
});
tokens.jwtBadAud = await signJwt({
	iss: "http://127.0.0.1:17047",
	aud: "wrong",
	exp: now + 3600,
	email: "e2e@local",
});
tokens.jwtBadSig = `${tokens.jwt.slice(0, Math.max(0, tokens.jwt.length - 4))}aaaa`;

await assertPortFree(17047);
const jwks = await listen(17047, (req, res) => {
	if (req.url?.includes("/cdn-cgi/access/certs")) {
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ keys: [jwk] }));
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
