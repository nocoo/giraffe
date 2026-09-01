import { APP_VERSION } from "../../lib/version";
import { type Env, envMode } from "../env";
import { ApiError } from "./errors";

const GITHUB_ORIGIN = "https://api.github.com";
const MAX_FETCHES = 40;

export class TruncatedError extends Error {
	constructor() {
		super("github fetch cap");
		this.name = "TruncatedError";
	}
}

export type GithubClient = {
	count: number;
	githubFetch: (url: string, init?: RequestInit) => Promise<Response>;
	githubApi: (token: string, path: string, init?: RequestInit) => Promise<Response>;
	githubGraphql: (
		token: string,
		query: string,
		variables: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
};

function allowedOrigin(env: Env): string {
	const mode = envMode(env.ENVIRONMENT);
	if (mode === "production") {
		return GITHUB_ORIGIN;
	}
	const base = env.GITHUB_API_BASE;
	if (!base) {
		throw new ApiError(500, "internal_error", "GITHUB_API_BASE required");
	}
	return new URL(base).origin;
}

function isRateLimited(res: Response, body: string): boolean {
	if (res.status === 429) {
		return true;
	}
	if (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0") {
		return true;
	}
	return res.status === 403 && /rate limit/i.test(body);
}

function mapStatus(res: Response, body: string): never {
	if (res.status === 401) {
		throw new ApiError(401, "github_unauthorized", "github unauthorized");
	}
	if (isRateLimited(res, body)) {
		throw new ApiError(503, "github_rate_limited", "github rate limited");
	}
	if (res.status === 403) {
		throw new ApiError(403, "github_forbidden", "github forbidden");
	}
	if (res.status === 404) {
		throw new ApiError(404, "not_found", "github not found");
	}
	throw new ApiError(502, "github_error", "github error");
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createGithubClient(env: Env, fetchImpl: FetchImpl = fetch): GithubClient {
	const origin = allowedOrigin(env);
	const client: GithubClient = {
		count: 0,
		async githubFetch(url, init) {
			if (new URL(url).origin !== new URL(origin).origin) {
				throw new ApiError(500, "internal_error", "github origin mismatch");
			}
			if (client.count >= MAX_FETCHES) {
				throw new TruncatedError();
			}
			client.count += 1;
			return fetchImpl(url, init);
		},
		async githubApi(token, path, init) {
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${token}`);
			headers.set("Accept", "application/vnd.github+json");
			headers.set("X-GitHub-Api-Version", "2022-11-28");
			headers.set("User-Agent", `giraffe/${APP_VERSION}`);
			const res = await client.githubFetch(`${origin}${path}`, { ...init, headers });
			if (res.status === 204 || res.status === 205 || res.status === 202) {
				return res;
			}
			if (!res.ok) {
				const body = await res.text();
				mapStatus(res, body);
			}
			return res;
		},
		async githubGraphql(token, query, variables) {
			const res = await client.githubFetch(`${origin}/graphql`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					"User-Agent": `giraffe/${APP_VERSION}`,
				},
				body: JSON.stringify({ query, variables }),
			});
			if (!res.ok) {
				const body = await res.text();
				mapStatus(res, body);
			}
			let payload: { data?: unknown; errors?: Array<{ type?: string; message?: string }> };
			try {
				payload = (await res.json()) as typeof payload;
			} catch {
				throw new ApiError(502, "github_error", "github error");
			}
			const errors = payload.errors ?? [];
			if (errors.some((e) => e.type === "RATE_LIMITED")) {
				throw new ApiError(503, "github_rate_limited", "github rate limited");
			}
			if (
				errors.length > 0 &&
				!errors.every((e) => e.type === "FORBIDDEN" || e.type === "NOT_FOUND")
			) {
				throw new ApiError(502, "github_error", "github error");
			}
			if (payload.data === null || typeof payload.data !== "object") {
				throw new ApiError(502, "github_error", "github error");
			}
			return payload.data as Record<string, unknown>;
		},
	};
	return client;
}
