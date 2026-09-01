import { APP_VERSION } from "../../lib/version";
import { type Env, envMode } from "../env";
import { ApiError } from "./errors";

const GITHUB_ORIGIN = "https://api.github.com";
export const MAX_FETCHES = 40;

export class TruncatedError extends Error {
	constructor() {
		super("github fetch cap");
		this.name = "TruncatedError";
	}
}

export type GithubClient = {
	count: number;
	graphqlErrors: Array<{ type?: string }>;
	githubFetch: (url: string, init?: RequestInit) => Promise<Response>;
	githubApi: (token: string, path: string, init?: RequestInit) => Promise<Response>;
	githubGraphql: (
		token: string,
		query: string,
		variables: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
};

function allowedBase(env: Env): string {
	const mode = envMode(env.ENVIRONMENT);
	if (mode === "production") {
		return GITHUB_ORIGIN;
	}
	const base = env.GITHUB_API_BASE;
	if (!base) {
		throw new ApiError(500, "internal_error", "GITHUB_API_BASE required");
	}
	return base.replace(/\/$/, "");
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

function dropNullNodes(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.filter((item) => item !== null).map(dropNullNodes);
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
			out[key] = dropNullNodes(nested);
		}
		return out;
	}
	return value;
}

function setNullAtPath(value: unknown, path: unknown[]): unknown {
	if (path.length === 0 || value === null || typeof value !== "object") {
		return null;
	}
	const [head, ...rest] = path;
	if (typeof head === "number" && Array.isArray(value)) {
		const copy = [...value];
		if (rest.length === 0) {
			copy[head] = null;
			return copy;
		}
		copy[head] = setNullAtPath(copy[head], rest);
		return copy;
	}
	if (typeof head === "string" && !Array.isArray(value)) {
		const record = { ...(value as Record<string, unknown>) };
		if (rest.length === 0) {
			record[head] = null;
			return record;
		}
		record[head] = setNullAtPath(record[head], rest);
		return record;
	}
	return value;
}

function dropPath(value: unknown, path: unknown[]): unknown {
	let end = path.length;
	for (let i = 0; i < path.length; i += 1) {
		if (typeof path[i] === "number") {
			end = i + 1;
		}
	}
	return setNullAtPath(value, path.slice(0, end));
}

function applyGraphqlErrors(
	data: Record<string, unknown>,
	errors: Array<{ type?: string; path?: unknown[] }>,
): Record<string, unknown> {
	let next: unknown = data;
	for (const error of errors) {
		if (!Array.isArray(error.path) || error.path.length === 0) {
			next = {};
			continue;
		}
		next = dropPath(next, error.path);
	}
	return dropNullNodes(next) as Record<string, unknown>;
}

async function readJsonBody(res: Response): Promise<string> {
	const text = await res.text();
	try {
		JSON.parse(text);
	} catch {
		throw new ApiError(502, "github_error", "github error");
	}
	return text;
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createGithubClient(env: Env, fetchImpl: FetchImpl = fetch): GithubClient {
	const base = allowedBase(env);
	const client: GithubClient = {
		count: 0,
		graphqlErrors: [],
		async githubFetch(url, init) {
			if (new URL(url).origin !== new URL(base).origin) {
				throw new ApiError(500, "internal_error", "github origin mismatch");
			}
			if (client.count >= MAX_FETCHES) {
				throw new TruncatedError();
			}
			client.count += 1;
			try {
				return await fetchImpl(url, init);
			} catch (err) {
				if (err instanceof ApiError || err instanceof TruncatedError) {
					throw err;
				}
				throw new ApiError(502, "github_error", "github error");
			}
		},
		async githubApi(token, path, init) {
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${token}`);
			headers.set("Accept", "application/vnd.github+json");
			headers.set("X-GitHub-Api-Version", "2022-11-28");
			headers.set("User-Agent", `giraffe/${APP_VERSION}`);
			const res = await client.githubFetch(`${base}${path}`, { ...init, headers });
			if (res.status === 204 || res.status === 205) {
				return res;
			}
			if (res.status === 202 && path === "/notifications") {
				return res;
			}
			if (!res.ok) {
				const body = await res.text();
				mapStatus(res, body);
			}
			const text = await readJsonBody(res);
			return new Response(text, { status: res.status, headers: res.headers });
		},
		async githubGraphql(token, query, variables) {
			client.graphqlErrors = [];
			const res = await client.githubFetch(`${base}/graphql`, {
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
			let payload: {
				data?: unknown;
				errors?: Array<{ type?: string; message?: string; path?: unknown[] }>;
			};
			try {
				payload = (await res.json()) as typeof payload;
			} catch {
				throw new ApiError(502, "github_error", "github error");
			}
			const errors = payload.errors ?? [];
			client.graphqlErrors = errors;
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
			const data = payload.data as Record<string, unknown>;
			if (errors.length > 0) {
				return applyGraphqlErrors(data, errors);
			}
			return data;
		},
	};
	return client;
}
