import type { UnavailableReasonCode } from "../../lib/factory-types";
import { APP_VERSION } from "../../lib/version";
import { type Env, envMode } from "../env";
import { ApiError } from "./errors";
import {
	classifyGithubUnavailable,
	GithubUnavailableError,
	githubAccessRestricted,
	unambiguousGithubNotFound,
} from "./github-unavailable";

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
	requests: { graphql: number; rest: number };
	graphqlErrors: Array<{
		type?: string;
		path: string[];
		reasonCode?: UnavailableReasonCode;
		unambiguousNotFound?: true;
		nodeNotFound?: true;
	}>;
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

function graphqlErrorSummary(errors: Array<{ message?: string }>): string {
	const messages = errors
		.map((error) => error.message?.trim())
		.filter((message): message is string => Boolean(message));
	if (messages.length === 0) return "github error";
	return messages.slice(0, 3).join("; ");
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

function rateLimitError(res: Response): ApiError {
	const retry = res.headers.get("retry-after");
	const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
	const delay = retry
		? /^\d+$/.test(retry)
			? Date.now() + Number(retry) * 1000
			: Date.parse(retry)
		: 0;
	const until = Math.max(
		Date.now() + 60_000,
		Number.isFinite(reset) ? reset : 0,
		Number.isFinite(delay) ? delay : 0,
	);
	return new ApiError(
		503,
		"github_rate_limited",
		"github rate limited",
		new Date(until).toISOString(),
		res.status,
	);
}

function mapStatus(res: Response, body: string): never {
	if (res.status === 401) {
		throw new ApiError(401, "github_unauthorized", "github unauthorized", null, res.status);
	}
	if (isRateLimited(res, body)) {
		throw rateLimitError(res);
	}
	if (res.status === 403 || res.status === 404) {
		let message: unknown;
		let diagnostics: unknown;
		try {
			diagnostics = JSON.parse(body);
			message = (diagnostics as { message?: unknown } | null)?.message;
		} catch {}
		throw new GithubUnavailableError(
			res.status,
			message,
			res.headers.has("x-github-sso") ||
				githubAccessRestricted(JSON.stringify(diagnostics) ?? body),
			res.status,
		);
	}
	throw new ApiError(502, "github_error", "github error", null, res.status);
}

const PATH_SEGMENTS = 8;
const SAFE_PATH_FIELDS = new Set([
	"id",
	"name",
	"nameWithOwner",
	"url",
	"description",
	"isPrivate",
	"isArchived",
	"isFork",
	"isEmpty",
	"pushedAt",
	"createdAt",
	"updatedAt",
	"closedAt",
	"mergedAt",
	"publishedAt",
	"diskUsage",
	"stargazerCount",
	"forkCount",
	"visibility",
	"owner",
	"login",
	"avatarUrl",
	"primaryLanguage",
	"defaultBranchRef",
	"target",
	"oid",
	"history",
	"totalCount",
	"languages",
	"totalSize",
	"pageInfo",
	"hasNextPage",
	"endCursor",
	"edges",
	"size",
	"node",
	"repositoryTopics",
	"nodes",
	"topic",
	"openIssues",
	"closedIssues",
	"openPrs",
	"closedPrs",
	"mergedPrs",
	"releases",
	"issues",
	"pullRequests",
	"state",
	"number",
	"title",
	"author",
	"labels",
	"comments",
	"isDraft",
	"additions",
	"deletions",
	"baseRefName",
	"headRefName",
	"reviewDecision",
	"mergeable",
	"mergeStateStatus",
	"tagName",
	"isPrerelease",
	"databaseId",
	"viewer",
	"repositories",
	"contributionsCollection",
	"contributionCalendar",
	"weeks",
	"contributionDays",
	"date",
	"contributionCount",
	"restrictedContributionsCount",
	"totalContributions",
	"rateLimit",
	"remaining",
	"resetAt",
]);
const SAFE_TYPES = new Set([
	"GRAPHQL",
	"VALIDATION",
	"VALIDATION_FAILED",
	"PARSE_FAILED",
	"FORBIDDEN",
	"NOT_FOUND",
	"RATE_LIMITED",
	"UNPROCESSABLE",
	"NON_NULL_VIOLATION",
	"NULL_VALUE_IN_NON_NULL_POSITION",
	"SERVICE_UNAVAILABLE",
	"INTERNAL",
]);
function safePath(path: unknown): string[] {
	if (!Array.isArray(path)) return [];
	return path
		.slice(0, PATH_SEGMENTS)
		.map((segment) =>
			typeof segment === "string" && SAFE_PATH_FIELDS.has(segment)
				? segment
				: typeof segment === "string"
					? "@"
					: typeof segment === "number" && Number.isSafeInteger(segment)
						? String(segment)
						: "@",
		);
}
function safeType(type: unknown): string {
	return typeof type === "string" && SAFE_TYPES.has(type) ? type : "UNKNOWN";
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

const DEFAULT_RESPONSE_BYTES = 20_000_000;
async function readBoundedBody(res: Response, maxBytes: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const large = () =>
		new ApiError(
			502,
			"github_response_too_large",
			`GitHub response exceeds ${maxBytes / 1e6} MB`,
			null,
			res.status,
		);
	if (Number(res.headers.get("content-length")) > maxBytes) {
		await reader.cancel();
		throw large();
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read().catch(() => {
			throw new ApiError(502, "github_error", "github error", null, res.status);
		});
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			throw large();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
async function readJsonBody(res: Response, maxBytes: number): Promise<string> {
	const text = await readBoundedBody(res, maxBytes);
	try {
		JSON.parse(text);
	} catch {
		throw new ApiError(502, "github_error", "github error", null, res.status);
	}
	return text;
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createGithubClient(
	env: Env,
	fetchImpl: FetchImpl = fetch,
	maxResponseBytes = DEFAULT_RESPONSE_BYTES,
	beforeRequest?: () => Promise<void>,
): GithubClient {
	const base = allowedBase(env);
	const client: GithubClient = {
		count: 0,
		requests: { graphql: 0, rest: 0 },
		graphqlErrors: [],
		async githubFetch(url, init) {
			const target = new URL(url);
			if (target.origin !== new URL(base).origin) {
				throw new ApiError(500, "internal_error", "github origin mismatch");
			}
			if (client.count >= MAX_FETCHES) {
				throw new TruncatedError();
			}
			await beforeRequest?.();
			client.count += 1;
			if (target.pathname === "/graphql") client.requests.graphql += 1;
			else client.requests.rest += 1;
			try {
				const response = await fetchImpl(url, {
					...init,
					redirect: "manual",
					signal: init?.signal ?? AbortSignal.timeout(15_000),
				});
				if (response.status >= 300 && response.status < 400) {
					throw new ApiError(
						502,
						"github_error",
						"github redirects are not allowed",
						null,
						response.status,
					);
				}
				return response;
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
			if (
				res.status === 202 &&
				(init?.method ?? "GET").toUpperCase() === "PUT" &&
				path === "/notifications"
			) {
				return res;
			}
			if (res.status === 202) {
				throw new ApiError(502, "github_error", "github error", null, res.status);
			}
			if (!res.ok) {
				const body = await readBoundedBody(res, maxResponseBytes);
				mapStatus(res, body);
			}
			const text = await readJsonBody(res, maxResponseBytes);
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
			if (res.status === 202) {
				throw new ApiError(502, "github_error", "github error", null, res.status);
			}
			if (!res.ok) {
				const body = await readBoundedBody(res, maxResponseBytes);
				mapStatus(res, body);
			}
			let payload: {
				data?: unknown;
				errors?: Array<{ type?: string; message?: string; path?: unknown[] }>;
			};
			try {
				payload = JSON.parse(await readJsonBody(res, maxResponseBytes)) as typeof payload;
			} catch (error) {
				if (error instanceof ApiError) throw error;
				throw new ApiError(502, "github_error", "github error", null, res.status);
			}
			const errors = payload.errors ?? [];
			const accessRestricted =
				res.headers.has("x-github-sso") ||
				githubAccessRestricted(JSON.stringify({ ...payload, data: undefined }));
			client.graphqlErrors = errors.map((error) => {
				const reportedId = /global id of ['"]([^'"\r\n]+)['"]/i.exec(error.message ?? "")?.[1];
				const unambiguousNotFound =
					!accessRestricted &&
					error.type === "NOT_FOUND" &&
					Array.isArray(error.path) &&
					error.path.length === 1 &&
					error.path[0] === "node" &&
					unambiguousGithubNotFound(404, error.message);
				return {
					path: safePath(error.path),
					...(error.type === undefined ? {} : { type: safeType(error.type) }),
					...(unambiguousNotFound ? { unambiguousNotFound: true as const } : {}),
					...(unambiguousNotFound &&
					typeof variables.id === "string" &&
					(reportedId === undefined || reportedId === variables.id) &&
					payload.data !== null &&
					typeof payload.data === "object" &&
					Object.hasOwn(payload.data, "node") &&
					(payload.data as Record<string, unknown>).node === null
						? { nodeNotFound: true as const }
						: {}),
					...(["FORBIDDEN", "NOT_FOUND"].includes(error.type ?? "")
						? {
								reasonCode: accessRestricted
									? "permission_denied"
									: classifyGithubUnavailable(error.type === "NOT_FOUND" ? 404 : 403, error.message)
											.reason_code,
							}
						: {}),
				};
			});
			if (errors.some((e) => e.type === "RATE_LIMITED")) {
				throw rateLimitError(res);
			}
			if (
				errors.length > 0 &&
				!errors.every((e) => e.type === "FORBIDDEN" || e.type === "NOT_FOUND")
			) {
				throw new ApiError(502, "github_error", graphqlErrorSummary(errors), null, res.status);
			}
			if (payload.data === null || typeof payload.data !== "object") {
				throw new ApiError(502, "github_error", graphqlErrorSummary(errors), null, res.status);
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
