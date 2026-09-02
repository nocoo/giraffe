import { ApiError, asErrorCode } from "./errors";

async function send(resource: string, init?: RequestInit): Promise<Response> {
	return fetch(`/api/${resource}`, { credentials: "same-origin", ...init });
}

async function parse<T>(res: Response): Promise<T> {
	if (res.status === 204) {
		return undefined as T;
	}
	const body: unknown = await res.json();
	if (!res.ok) {
		const err =
			body && typeof body === "object" && "error" in body
				? (body as { error?: { code?: string; message?: string } }).error
				: undefined;
		throw new ApiError(
			res.status,
			asErrorCode(typeof err?.code === "string" ? err.code : "internal_error"),
			typeof err?.message === "string" ? err.message : "request failed",
		);
	}
	return body as T;
}

export async function apiGet<T>(resource: string): Promise<T> {
	return parse<T>(await send(resource));
}

export async function apiPost<T>(resource: string, body?: unknown): Promise<T> {
	const init: RequestInit = { method: "POST" };
	if (body !== undefined) {
		init.headers = { "content-type": "application/json" };
		init.body = JSON.stringify(body);
	}
	return parse<T>(await send(resource, init));
}

export async function apiDelete(resource: string): Promise<void> {
	await parse(await send(resource, { method: "DELETE" }));
}
