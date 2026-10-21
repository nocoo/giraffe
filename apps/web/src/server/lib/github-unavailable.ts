import type { UnavailableReasonCode } from "../../lib/factory-types";
import { ApiError } from "./errors";

const REASONS: Record<UnavailableReasonCode, string> = {
	alerts_disabled: "Dependabot alerts are disabled for this repository",
	permission_denied: "GitHub token lacks permission to access this resource",
	not_found: "GitHub resource was not found or is not visible to this token",
	unknown: "GitHub resource is unavailable for an unrecognized access restriction",
};

export function unavailableReason(reason_code: UnavailableReasonCode) {
	return { reason_code, reason: REASONS[reason_code] };
}

export function classifyGithubUnavailable(status: number, message: unknown) {
	const text = typeof message === "string" ? message : "";
	const reason = /dependabot alerts? (?:are |is )?(?:disabled|not enabled)/i.test(text)
		? "alerts_disabled"
		: /resource not accessible by (?:integration|personal access token)|insufficient (?:scope|permission)|must have .* (?:scope|permission)/i.test(
					text,
				)
			? "permission_denied"
			: status === 404
				? "not_found"
				: "unknown";
	return unavailableReason(reason);
}

export class GithubUnavailableError extends ApiError {
	readonly reasonCode: UnavailableReasonCode;

	constructor(status: number, message: unknown) {
		const classified = classifyGithubUnavailable(status, message);
		super(status, status === 404 ? "not_found" : "github_forbidden", classified.reason);
		this.reasonCode = classified.reason_code;
	}
}

export function githubUnavailability(error: unknown) {
	if (!(error instanceof ApiError) || !["github_forbidden", "not_found"].includes(error.code))
		return null;
	return unavailableReason(
		error instanceof GithubUnavailableError
			? error.reasonCode
			: error.code === "not_found"
				? "not_found"
				: "unknown",
	);
}
