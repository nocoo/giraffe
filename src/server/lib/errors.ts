import { sanitize } from "./sanitize";

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(sanitize(message));
		this.status = status;
		this.code = code;
	}
}

export function jsonError(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message: sanitize(message) } }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

export function jsonOk(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

export function errorResponse(err: ApiError): Response {
	return jsonError(err.status, err.code, err.message);
}

export function toErrorResponse(err: unknown): Response {
	if (err instanceof ApiError) {
		return errorResponse(err);
	}
	return jsonError(500, "internal_error", err instanceof Error ? err.message : "error");
}
