const AVATAR_PALETTE = [
	"#0f766e",
	"#0369a1",
	"#4338ca",
	"#7c3aed",
	"#be185d",
	"#c2410c",
	"#b45309",
	"#15803d",
	"#047857",
	"#0e7490",
	"#1d4ed8",
	"#6d28d9",
] as const;

export function hashGithubLogin(login: string): number {
	let hash = 0;
	for (let index = 0; index < login.length; index += 1) {
		hash = (hash * 31 + login.charCodeAt(index)) >>> 0;
	}
	return hash;
}

export function githubAvatarColor(login: string): string {
	const key = login.trim().toLowerCase();
	if (key === "") return AVATAR_PALETTE[0];
	return AVATAR_PALETTE[hashGithubLogin(key) % AVATAR_PALETTE.length] ?? AVATAR_PALETTE[0];
}

export function githubAvatarLetter(login: string | null | undefined): string {
	const trimmed = login?.trim() ?? "";
	if (trimmed === "") return "?";
	const match = trimmed.match(/[A-Za-z0-9]/);
	return (match?.[0] ?? trimmed.charAt(0)).toUpperCase();
}

export function resolveGithubAvatarUrl(
	login: string | null | undefined,
	avatarUrl?: string | null,
	size = 64,
): string | null {
	const trimmed = login?.trim() ?? "";
	const saved = avatarUrl?.trim();
	if (saved) return saved;
	if (trimmed === "") return null;
	return `https://avatars.githubusercontent.com/${encodeURIComponent(trimmed)}?size=${size}`;
}
