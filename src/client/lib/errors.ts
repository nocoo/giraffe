export const ERROR_CODES = [
	"validation_failed",
	"scopes_missing",
	"access_unauthorized",
	"github_unauthorized",
	"origin_forbidden",
	"github_forbidden",
	"not_found",
	"method_not_allowed",
	"account_missing",
	"snapshot_missing",
	"capability_missing",
	"account_conflict",
	"encryption_misconfigured",
	"access_misconfigured",
	"db_error",
	"internal_error",
	"github_error",
	"github_rate_limited",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const KNOWN = new Set<string>(ERROR_CODES);

export function asErrorCode(code: string): ErrorCode {
	if (KNOWN.has(code)) {
		return code as ErrorCode;
	}
	return "internal_error";
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: ErrorCode;

	constructor(status: number, code: ErrorCode, message: string) {
		super(message);
		this.status = status;
		this.code = code;
		this.name = "ApiError";
	}
}
