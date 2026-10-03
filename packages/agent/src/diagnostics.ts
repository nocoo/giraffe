export function safeDiagnostics(output: string): string {
	const bounded = output
		.split("\n")
		.slice(0, 100)
		.map((line) => (line.length > 4096 ? "[oversized diagnostic line omitted]" : line))
		.join("\n");
	const text = bounded
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
			"[redacted]",
		)
		.replace(
			/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|giraffe_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)/g,
			"[redacted]",
		)
		.replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, "[redacted]")
		.replace(
			/(^|\n)\s*(?:set-cookie|cookie|authorization|proxy-authorization)\s*:[^\n]*/gi,
			"$1[redacted]",
		)
		.replace(
			/\b((?:[A-Za-z0-9_-]*(?:token|api[_-]?key|secret|password|credential)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
			"$1[redacted]",
		)
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/\p{Cc}/gu, (character) =>
			character === "\n" || character === "\t" ? character : "",
		);
	let result = "",
		bytes = 0;
	for (const character of text) {
		const size = Buffer.byteLength(character);
		if (bytes + size > 2048) break;
		result += character;
		bytes += size;
	}
	return result;
}
