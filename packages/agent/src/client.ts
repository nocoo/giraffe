import { z } from "zod";
import { type Credential, serviceUrl } from "./config.ts";
import { observationSchema, type Resource, resourceSchema } from "./contracts.ts";

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string) {
		super(`Giraffe API ${status}: ${code}`);
		this.status = status;
		this.code = code;
	}
}
export function retryableApiError(error: unknown): error is ApiError {
	return (
		error instanceof ApiError &&
		([0, 401, 403, 408, 429].includes(error.status) ||
			error.status >= 500 ||
			(error.status === 409 && error.code === "revision_conflict"))
	);
}
export type Collection = "records" | "reports" | "jobs";
export type ResourceInput = Pick<
	Resource,
	"id" | "type" | "status" | "repository" | "source_version" | "payload"
>;
const itemResponse = z.object({ account_id: z.string(), item: resourceSchema });
const listResponse = z.object({
	account_id: z.string(),
	items: z.array(resourceSchema),
	nextCursor: z.string().nullable(),
});
export const identitySchema = z.object({
	account_id: z.string(),
	login: z.string(),
	token: z.object({
		id: z.string(),
		scopes: z.array(z.string()),
		expires_at: z.string(),
	}),
});

export class GiraffeClient {
	readonly prefix: string;
	readonly baseUrl: string;
	readonly credential: Credential;
	private readonly transport: typeof fetch;
	constructor(credential: Credential, transport: typeof fetch = fetch) {
		this.credential = credential;
		this.transport = transport;
		this.baseUrl = serviceUrl.parse(credential.baseUrl).replace(/\/$/, "");
		this.prefix = `/api/v1/accounts/${encodeURIComponent(credential.account_id)}`;
	}

	async request(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const timeout = AbortSignal.timeout(30000);
		let response: Response;
		try {
			response = await this.transport(`${this.baseUrl}${path}`, {
				method,
				redirect: "error",
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				headers: {
					authorization: `Bearer ${this.credential.token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new ApiError(0, "connection_failed");
		}
		if (response.status === 204) return undefined;
		if (!response.ok) {
			let code = "request_failed";
			try {
				const error = z
					.object({
						error: z.object({ code: z.string().regex(/^[a-z_]{1,80}$/) }),
					})
					.safeParse(await response.json());
				if (error.success) code = error.data.error.code;
			} catch {}
			throw new ApiError(response.status, code);
		}
		return response.json();
	}

	async me() {
		const result = identitySchema.parse(await this.request("GET", "/api/v1/me"));
		this.checkAccount(result.account_id);
		return result;
	}

	async observation(path: string, signal?: AbortSignal) {
		const result = observationSchema.parse(
			await this.request("GET", `${this.prefix}/${path}`, undefined, signal),
		);
		this.checkAccount(result.account_id);
		return result;
	}

	async get(collection: Collection, id: string, signal?: AbortSignal): Promise<Resource | null> {
		try {
			return this.item(await this.request("GET", this.path(collection, id), undefined, signal));
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) return null;
			throw error;
		}
	}

	async list(
		collection: Collection,
		filters: { type?: string; status?: string; repository?: string } = {},
	): Promise<Resource[]> {
		const results: Resource[] = [];
		const seen = new Set<string>();
		let cursor: string | null = null;
		for (let page = 0; page < 100; page++) {
			const params = new URLSearchParams({
				...filters,
				limit: "100",
				...(cursor ? { cursor } : {}),
			});
			const result = listResponse.parse(
				await this.request("GET", `${this.path(collection)}?${params}`),
			);
			this.checkAccount(result.account_id);
			for (const item of result.items) {
				this.checkAccount(item.account_id);
				results.push(item);
			}
			if (!result.nextCursor) return results;
			if (seen.has(result.nextCursor)) throw new ApiError(502, "pagination_loop");
			seen.add(result.nextCursor);
			cursor = result.nextCursor;
		}
		throw new ApiError(502, "pagination_limit");
	}

	async create(
		collection: Collection,
		input: ResourceInput,
		signal?: AbortSignal,
	): Promise<Resource> {
		if (Buffer.byteLength(JSON.stringify(input.payload)) > 64 * 1024)
			throw new ApiError(413, "payload_too_large");
		try {
			return this.item(await this.request("POST", this.path(collection), input, signal));
		} catch (error) {
			if (error instanceof ApiError && error.status === 409 && error.code === "resource_exists") {
				const existing = await this.get(collection, input.id, signal);
				if (
					existing &&
					existing.type === input.type &&
					existing.source_version === input.source_version &&
					existing.repository === input.repository
				)
					return existing;
			}
			throw error;
		}
	}

	async update(
		collection: Collection,
		existing: Resource,
		patch: Partial<Omit<ResourceInput, "id">>,
	): Promise<Resource> {
		return this.item(
			await this.request("PATCH", this.path(collection, existing.id), {
				revision: existing.revision,
				...patch,
			}),
		);
	}

	async remove(collection: Collection, existing: Resource): Promise<void> {
		await this.request(
			"DELETE",
			`${this.path(collection, existing.id)}?revision=${existing.revision}`,
		);
	}

	private path(collection: Collection, id?: string) {
		return `${this.prefix}/agent/${collection}${id === undefined ? "" : `/${encodeURIComponent(id)}`}`;
	}
	private item(value: unknown): Resource {
		const result = itemResponse.parse(value);
		this.checkAccount(result.account_id);
		this.checkAccount(result.item.account_id);
		return result.item;
	}
	private checkAccount(account: string) {
		if (account !== this.credential.account_id) throw new ApiError(502, "account_mismatch");
	}
}
