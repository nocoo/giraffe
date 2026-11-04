import { sanitize } from "./sanitize";
import type { SourceTiming } from "./source-timing";

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;
	readonly retryAt: string | null;
	readonly upstreamStatus: number | null;
	readonly details: Record<string, string> | null;

	constructor(
		status: number,
		code: string,
		message: string,
		retryAt: string | null = null,
		upstreamStatus: number | null = null,
		details: Record<string, string> | null = null,
	) {
		super(sanitize(message));
		this.status = status;
		this.code = code;
		this.retryAt = retryAt;
		this.upstreamStatus = upstreamStatus;
		this.details = details;
	}
}

export function jsonError(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message: sanitize(message) } }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

export function jsonOk(
	body: unknown,
	status = 200,
	headers?: Record<string, string>,
	timing?: SourceTiming,
): Response {
	return new Response(timing ? timing.stringify(body) : JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...headers,
		},
	});
}

export function errorResponse(err: ApiError): Response {
	const error: { code: string; message: string } & Record<string, string> = {
		code: err.code,
		message: sanitize(err.message),
		...(err.details ?? {}),
	};
	return new Response(JSON.stringify({ error }), {
		status: err.status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

export function toErrorResponse(err: unknown): Response {
	if (err instanceof ApiError) {
		return errorResponse(err);
	}
	return jsonError(500, "internal_error", err instanceof Error ? err.message : "error");
}
