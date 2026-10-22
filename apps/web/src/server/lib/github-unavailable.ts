import type { UnavailableReasonCode } from "../../lib/factory-types";
import { ApiError } from "./errors";

const REASONS: Record<UnavailableReasonCode, string> = {
	alerts_disabled: "Dependabot alerts are disabled for this repository",
	code_scanning_disabled: "Code scanning is disabled for this repository",
	permission_denied: "GitHub token lacks permission to access this resource",
	not_found: "GitHub resource was not found or is not visible to this token",
	unknown: "GitHub resource is unavailable for an unrecognized access restriction",
};

export function unavailableReason(reason_code: UnavailableReasonCode) {
	return { reason_code, reason: REASONS[reason_code] };
}

export function githubAccessRestricted(message: unknown): boolean {
	return (
		typeof message === "string" &&
		/not accessible|permission|\bscopes?\b|\bsaml\b|\bsso\b|single[- ]sign[- ]on|access (?:denied|revoked|restricted|forbidden)|must have .* (?:access|rights)/i.test(
			message.replaceAll("_", " "),
		)
	);
}

export function classifyGithubUnavailable(status: number, message: unknown) {
	const text = typeof message === "string" ? message : "";
	const reason = /dependabot alerts? (?:are |is )?(?:disabled|not enabled)/i.test(text)
		? "alerts_disabled"
		: /code scanning(?: alerts?)? (?:are |is )?(?:disabled|not enabled)/i.test(text)
			? "code_scanning_disabled"
			: githubAccessRestricted(text)
				? "permission_denied"
				: status === 404
					? "not_found"
					: "unknown";
	return unavailableReason(reason);
}

export class GithubUnavailableError extends ApiError {
	readonly reasonCode: UnavailableReasonCode;
	readonly unambiguousNotFound: boolean;

	constructor(status: number, message: unknown, accessRestricted = false) {
		const classified = accessRestricted
			? unavailableReason("permission_denied")
			: classifyGithubUnavailable(status, message);
		super(status, status === 404 ? "not_found" : "github_forbidden", classified.reason);
		this.reasonCode = classified.reason_code;
		this.unambiguousNotFound = !accessRestricted && unambiguousGithubNotFound(status, message);
	}
}

export function unambiguousGithubNotFound(status: number, message: unknown): boolean {
	return (
		status === 404 &&
		typeof message === "string" &&
		/^(?:not found|could not resolve to a node with the global id of ['"][^'"\r\n]+['"]\.?)$/i.test(
			message.trim(),
		)
	);
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
