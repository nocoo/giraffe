import { ApiError } from "./errors";

export type FactoryEndReason =
	| "wall"
	| "requests"
	| "statements"
	| "snapshot_boundary"
	| "publish_boundary"
	| "yield"
	| "completed"
	| "lost_lease"
	| "save_failed"
	| "error"
	| "run_end";

const ERROR_MESSAGES = new Map([
	["db_error", "d1 operation failed"],
	["factory_lease_lost", "factory lease lost"],
	["factory_yield", "factory invocation yielded"],
	["queue_overloaded", "queue send overloaded"],
	["github_error", "github operation failed"],
	["github_rate_limited", "github rate limited"],
	["github_forbidden", "github access forbidden"],
	["github_unauthorized", "github authorization failed"],
	["github_response_too_large", "github response too large"],
	["factory_capacity", "factory capacity exceeded"],
	["checkpoint_invalid", "factory checkpoint invalid"],
	["worker_interrupted", "factory worker interrupted"],
	["snapshot_missing", "factory snapshot missing"],
	["snapshot_incomplete", "factory snapshot incomplete"],
	["snapshot_unavailable", "factory snapshot unavailable"],
	["snapshot_sources_incomplete", "factory snapshot sources incomplete"],
	["catalog_changed", "factory catalog changed"],
	["catalog_incomplete", "factory catalog incomplete"],
	["account_missing", "factory account missing"],
	["account_conflict", "factory account conflict"],
	["repository_unavailable", "factory repository unavailable"],
	["repository_cooldown", "factory repository cooling down"],
	["refresh_cooldown", "factory refresh cooling down"],
	["schedule_deferred", "factory schedule deferred"],
	["validation_failed", "factory validation failed"],
	["not_found", "factory resource not found"],
	["encryption_key_missing", "factory encryption key missing"],
	["internal_error", "factory operation failed"],
]);

function safeFactoryError(error: unknown): Record<string, string> {
	try {
		const name =
			error instanceof TypeError ? "TypeError" : error instanceof ApiError ? "ApiError" : "Error";
		const value = error && typeof error === "object" ? error : {};
		const property = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
		const rawCode = property("code");
		const code = typeof rawCode === "string" ? rawCode : "";
		const normalizedMessage = ERROR_MESSAGES.get(code);
		if (normalizedMessage) return { name, code, message: normalizedMessage };
		const message = typeof error === "string" ? error : property("message");
		const overload =
			[rawCode, property("status"), property("statusCode")].some(
				(value) => value === 10250 || value === "10250" || value === 429 || value === "429",
			) ||
			(typeof message === "string" && /\b(?:10250|429)\b/.test(message));
		return {
			name,
			code: overload ? "queue_overloaded" : "internal_error",
			message: overload ? "queue send overloaded" : "factory operation failed",
		};
	} catch {
		return { name: "Error", code: "internal_error", message: "factory operation failed" };
	}
}

export function logFactory(event: string, fields: Record<string, unknown>, error?: unknown): void {
	console.log(
		JSON.stringify({
			...fields,
			event,
			error: error === undefined ? undefined : safeFactoryError(error),
		}),
	);
}
