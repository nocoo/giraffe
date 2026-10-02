const CLASSIC_PAT = /ghp_[A-Za-z0-9]{36}/g;
const FINE_PAT = /github_pat_[A-Za-z0-9_]+/g;
const BEARER = /Bearer .+/gi;
function redactEnvelopes(text: string): string {
	return text.replace(/\{[^{}]+\}/g, (chunk) => {
		try {
			const parsed = JSON.parse(chunk) as { iv?: unknown; ct?: unknown; tag?: unknown };
			if (
				parsed &&
				typeof parsed === "object" &&
				"iv" in parsed &&
				"ct" in parsed &&
				"tag" in parsed
			) {
				return "[redacted]";
			}
		} catch {
			return chunk;
		}
		return chunk;
	});
}

export function sanitize(text: string): string {
	return redactEnvelopes(
		text
			.replace(CLASSIC_PAT, "[redacted]")
			.replace(FINE_PAT, "[redacted]")
			.replace(BEARER, "Bearer [redacted]"),
	);
}
