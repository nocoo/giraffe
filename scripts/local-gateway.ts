import { execFile } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const PROD = "https://giraffe.hexly.ai";
const LOCAL = "http://127.0.0.1:37045";
const run = promisify(execFile);
type Mode = "local" | "prod";

class GatewayError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function json(body: unknown, status = 200) {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function loginRequired() {
	return new GatewayError(
		401,
		"local_prod_login_required",
		"线上认证已失效，请运行 bun run login:prod 后重试",
	);
}

export async function readAccessToken(): Promise<string> {
	const result = await run("cloudflared", ["access", "token", "--app", PROD], {
		timeout: 5000,
		maxBuffer: 64 * 1024,
		encoding: "utf8",
	});
	return result.stdout.trim();
}

export function createLocalGateway(
	options: { fetch?: typeof fetch; token?: () => Promise<string> } = {},
) {
	const fetchUpstream = options.fetch ?? fetch;
	const readToken = options.token ?? readAccessToken;
	const csrfToken = randomUUID();
	let target = { mode: "local" as Mode, instanceId: randomUUID() };
	let selecting = false;
	let credential: Promise<string> | undefined;
	let expires = 0;
	const descriptor = () => ({ ...target, csrfToken });
	const stale = () =>
		new GatewayError(409, "local_environment_expired", "本地数据源已切换，请重新加载页面");

	async function forward(request: Request, mode: Mode, path: string): Promise<Response> {
		const headers = new Headers();
		for (const name of ["accept", "content-type", "origin"]) {
			const value = request.headers.get(name);
			if (value) headers.set(name, value);
		}
		if (mode === "prod") {
			try {
				if (!credential || Date.now() >= expires) {
					credential = readToken();
					expires = Date.now() + 60_000;
				}
				const token = await credential;
				if (!token || /\s/.test(token)) throw loginRequired();
				headers.set("cookie", `CF_Authorization=${token}`);
			} catch {
				credential = undefined;
				throw loginRequired();
			}
			headers.set("origin", PROD);
			headers.set("sec-fetch-site", "same-origin");
		}
		const response = await fetchUpstream(`${mode === "prod" ? PROD : LOCAL}${path}`, {
			method: request.method,
			headers,
			...(["GET", "HEAD"].includes(request.method)
				? {}
				: { body: new Uint8Array(await request.arrayBuffer()) }),
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
		if (
			mode === "prod" &&
			(response.headers.has("location") ||
				response.headers.get("content-type")?.includes("text/html") ||
				[401, 403].includes(response.status))
		) {
			credential = undefined;
			await response.body?.cancel();
			throw loginRequired();
		}
		const output = new Headers(response.headers);
		for (const name of [
			"set-cookie",
			"location",
			"content-length",
			"content-encoding",
			"transfer-encoding",
			"connection",
		])
			output.delete(name);
		output.set("cache-control", "no-store");
		return new Response(response.body, { status: response.status, headers: output });
	}

	async function dispatch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const origin = request.headers.get("origin");
		const safe = ["GET", "HEAD"].includes(request.method);
		if (
			!["giraffe.dev.hexly.ai", "localhost:7045", "127.0.0.1:7045"].includes(url.host) ||
			request.headers.get("sec-fetch-site") === "cross-site" ||
			(origin !== null && origin !== url.origin) ||
			(!safe && !origin)
		)
			throw new GatewayError(403, "origin_forbidden", "仅允许本地同源请求");
		const captured = target;
		if (request.headers.get("x-giraffe-local-instance") !== captured.instanceId) throw stale();
		if (url.pathname === "/api/__local/environment") {
			if (request.method !== "POST")
				throw new GatewayError(405, "method_not_allowed", "仅允许 POST");
			const csrf = request.headers.get("x-giraffe-local-csrf") ?? "";
			if (
				Buffer.byteLength(csrf) !== Buffer.byteLength(csrfToken) ||
				!timingSafeEqual(Buffer.from(csrf), Buffer.from(csrfToken))
			)
				throw new GatewayError(403, "origin_forbidden", "数据源切换校验失败");
			const input = (await request.json().catch(() => null)) as { mode?: unknown } | null;
			if (input?.mode !== "local" && input?.mode !== "prod")
				throw new GatewayError(400, "validation_failed", "无效的数据源");
			if (selecting || target !== captured) throw stale();
			selecting = true;
			try {
				if (input.mode !== captured.mode) {
					if (input.mode === "prod") {
						const probe = await forward(new Request(`${url.origin}/api/me`), "prod", "/api/me");
						await probe.body?.cancel();
						if (!probe.ok)
							throw new GatewayError(
								502,
								"local_proxy_unavailable",
								"线上服务暂时不可用，数据源未切换",
							);
					}
					target = { mode: input.mode, instanceId: randomUUID() };
					credential = undefined;
				}
				return json(descriptor());
			} finally {
				selecting = false;
			}
		}
		if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/__local/"))
			throw new GatewayError(404, "not_found", "未找到接口");
		if (captured.mode === "prod" && (!safe || url.pathname.startsWith("/api/v1/")))
			throw new GatewayError(403, "local_read_only", "线上数据为只读，请切回 Local 后操作");
		return forward(request, captured.mode, `${url.pathname}${url.search}`);
	}

	return {
		descriptor,
		async handle(request: Request): Promise<Response> {
			try {
				return await dispatch(request);
			} catch (error) {
				return error instanceof GatewayError
					? json({ error: { code: error.code, message: error.message } }, error.status)
					: json(
							{
								error: {
									code: "local_proxy_unavailable",
									message: "数据代理暂时不可用，请检查连接后重试",
								},
							},
							502,
						);
			}
		},
	};
}
