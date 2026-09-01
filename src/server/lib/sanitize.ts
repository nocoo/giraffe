const CLASSIC_PAT = /ghp_[A-Za-z0-9]{36}/g;
const FINE_PAT = /github_pat_[A-Za-z0-9_]+/g;
const BEARER = /Bearer .+/gi;
const ENVELOPE = /\{[^{}]*"iv"[^{}]*"ct"[^{}]*"tag"[^{}]*\}/g;

export function sanitize(text: string): string {
	return text
		.replace(CLASSIC_PAT, "[redacted]")
		.replace(FINE_PAT, "[redacted]")
		.replace(BEARER, "Bearer [redacted]")
		.replace(ENVELOPE, "[redacted]");
}
