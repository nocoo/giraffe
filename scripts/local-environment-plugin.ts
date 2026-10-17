import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Plugin } from "vite";
import { createLocalGateway } from "./local-gateway";

export function localMiddleware(gateway: ReturnType<typeof createLocalGateway>) {
	return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
		if (!req.url?.startsWith("/api/") && req.url !== "/api") return next();
		void (async () => {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const value of req) {
				const chunk = Buffer.from(value);
				size += chunk.length;
				if (size > 2 * 1024 * 1024) {
					res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
					res.end(
						JSON.stringify({ error: { code: "validation_failed", message: "请求内容过大" } }),
					);
					return;
				}
				chunks.push(chunk);
			}
			const headers = new Headers();
			for (const [name, value] of Object.entries(req.headers)) {
				if (value) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
			const host = req.headers.host ?? "invalid";
			const scheme = host === "giraffe.dev.hexly.ai" ? "https" : "http";
			const method = req.method ?? "GET";
			const response = await gateway.handle(
				new Request(`${scheme}://${host}${req.url}`, {
					method,
					headers,
					...(["GET", "HEAD"].includes(method) ? {} : { body: Buffer.concat(chunks) }),
				}),
			);
			res.writeHead(response.status, Object.fromEntries(response.headers));
			if (response.body)
				await pipeline(
					Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
					res,
				);
			else res.end();
		})().catch(() => {
			if (res.headersSent) res.destroy();
			else {
				res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
				res.end(
					JSON.stringify({
						error: { code: "local_proxy_unavailable", message: "本地代理请求失败" },
					}),
				);
			}
		});
	};
}

export function localEnvironmentPlugin(): Plugin {
	const gateway = createLocalGateway();
	return {
		name: "giraffe-local-environment",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use(localMiddleware(gateway));
		},
		transformIndexHtml() {
			return [
				{
					tag: "script",
					children: `window.__GIRAFFE_LOCAL__=${JSON.stringify(gateway.descriptor())}`,
					injectTo: "head-prepend",
				},
			];
		},
	};
}
