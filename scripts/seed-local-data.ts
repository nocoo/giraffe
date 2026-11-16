type SeedRepoSpec = {
	owner: string;
	name: string;
	description: string;
	language: string;
	languages: { name: string; bytes: number }[];
	topics: string[];
	isPrivate: boolean;
	isFork: boolean;
	isArchived: boolean;
	starred: boolean;
	starSource: "owner" | "agent";
	category: "app" | "docs-vault" | "profile" | "repro" | "derivative";
	diskKiB: number;
	pushedDaysAgo: number;
	commits30d: number;
	ciMode: "healthy" | "flaky" | "failing" | "none";
	releaseCount: number;
	alertCount: number;
};

const ACCOUNT_ID = "acc_demo_local";
const ACCOUNT_LOGIN = "alexchen";
const TIMEZONE = "Asia/Shanghai";
const RUN_ID = "run_demo_20261117_0300";
const PRIOR_RUN_ID = "run_demo_20261116_0300";
const PARTIAL_RUN_ID = "run_demo_20261115_1420";

const REPO_SPECS: SeedRepoSpec[] = [
	{
		owner: ACCOUNT_LOGIN,
		name: "giraffe-console",
		description: "Personal GitHub operations console with Cloudflare Workers and Basalt UI",
		language: "TypeScript",
		languages: [
			{ name: "TypeScript", bytes: 482_000 },
			{ name: "CSS", bytes: 41_200 },
			{ name: "Shell", bytes: 8_400 },
		],
		topics: ["cloudflare-workers", "react", "github", "dashboard"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 4_820,
		pushedDaysAgo: 0,
		commits30d: 46,
		ciMode: "healthy",
		releaseCount: 4,
		alertCount: 1,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "basalt-kit",
		description: "Design tokens and accessible React primitives for dense engineering tools",
		language: "TypeScript",
		languages: [
			{ name: "TypeScript", bytes: 318_000 },
			{ name: "CSS", bytes: 64_500 },
		],
		topics: ["design-system", "react", "tailwindcss", "ui"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 3_120,
		pushedDaysAgo: 1,
		commits30d: 32,
		ciMode: "healthy",
		releaseCount: 3,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "herdr-daemon",
		description: "Terminal multiplexer and agent session supervisor in Go",
		language: "Go",
		languages: [
			{ name: "Go", bytes: 294_000 },
			{ name: "Shell", bytes: 12_100 },
		],
		topics: ["cli", "go", "tmux", "agents"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 2_640,
		pushedDaysAgo: 0,
		commits30d: 28,
		ciMode: "flaky",
		releaseCount: 2,
		alertCount: 1,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "edge-kv-router",
		description: "Zero-cold-start edge request router backed by D1 and KV",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 145_000 }],
		topics: ["cloudflare-workers", "edge", "router"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 1_480,
		pushedDaysAgo: 2,
		commits30d: 19,
		ciMode: "healthy",
		releaseCount: 2,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "vault-notes",
		description: "Encrypted markdown knowledge base synced via git hooks",
		language: "Markdown",
		languages: [
			{ name: "Markdown", bytes: 620_000 },
			{ name: "Shell", bytes: 6_200 },
		],
		topics: ["notes", "markdown", "pkm"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "docs-vault",
		diskKiB: 6_900,
		pushedDaysAgo: 0,
		commits30d: 25,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "nmem-cli",
		description: "Local semantic memory index for CLI workflows using SQLite FTS5",
		language: "Rust",
		languages: [
			{ name: "Rust", bytes: 215_000 },
			{ name: "Shell", bytes: 4_100 },
		],
		topics: ["rust", "sqlite", "cli", "search"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 2_210,
		pushedDaysAgo: 3,
		commits30d: 16,
		ciMode: "failing",
		releaseCount: 1,
		alertCount: 2,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "pulse-metrics",
		description: "Lightweight OpenTelemetry collector & DuckDB rollup exporter",
		language: "Python",
		languages: [
			{ name: "Python", bytes: 184_000 },
			{ name: "SQL", bytes: 22_000 },
		],
		topics: ["observability", "python", "duckdb"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 1_920,
		pushedDaysAgo: 4,
		commits30d: 14,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 1,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "dotfiles",
		description: "macOS zsh, ghostty, neovim, and homebrew bundle configuration",
		language: "Shell",
		languages: [
			{ name: "Shell", bytes: 52_000 },
			{ name: "Lua", bytes: 38_000 },
		],
		topics: ["dotfiles", "macos", "neovim", "zsh"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "profile",
		diskKiB: 840,
		pushedDaysAgo: 1,
		commits30d: 11,
		ciMode: "healthy",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "base-ci-workflows",
		description: "Reusable GitHub Actions workflows for TypeScript, Go, and Worker deployments",
		language: "YAML",
		languages: [
			{ name: "YAML", bytes: 44_000 },
			{ name: "Shell", bytes: 11_000 },
		],
		topics: ["github-actions", "ci", "devops"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 510,
		pushedDaysAgo: 5,
		commits30d: 9,
		ciMode: "healthy",
		releaseCount: 2,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "beacon-status",
		description: "Minimal status page and synthetic probe runner on Cloudflare Workers",
		language: "TypeScript",
		languages: [
			{ name: "TypeScript", bytes: 162_000 },
			{ name: "CSS", bytes: 19_000 },
		],
		topics: ["monitoring", "cloudflare-workers", "status-page"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 1_650,
		pushedDaysAgo: 6,
		commits30d: 12,
		ciMode: "flaky",
		releaseCount: 1,
		alertCount: 1,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "lantern-proxy",
		description: "Local HTTP/SOCKS5 inspectable dev proxy with HAR export",
		language: "Go",
		languages: [{ name: "Go", bytes: 178_000 }],
		topics: ["go", "proxy", "networking", "devtools"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 1_790,
		pushedDaysAgo: 8,
		commits30d: 8,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "quartz-reader",
		description: "Distraction-free RSS & Atom reader with offline SQLite sync",
		language: "Swift",
		languages: [{ name: "Swift", bytes: 265_000 }],
		topics: ["swift", "macos", "rss"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 3_400,
		pushedDaysAgo: 10,
		commits30d: 7,
		ciMode: "failing",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "cron-atlas",
		description: "Visual cron expression scheduler and execution history viewer",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 128_000 }],
		topics: ["react", "cron", "scheduler"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "agent",
		category: "app",
		diskKiB: 1_240,
		pushedDaysAgo: 12,
		commits30d: 6,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "schema-diff",
		description: "Deterministic SQLite & D1 migration diff checker",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 96_000 }],
		topics: ["sqlite", "d1", "migrations"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 890,
		pushedDaysAgo: 14,
		commits30d: 5,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "clipper-ext",
		description: "Browser extension to save clean markdown snippets into vault-notes",
		language: "TypeScript",
		languages: [
			{ name: "TypeScript", bytes: 84_000 },
			{ name: "HTML", bytes: 9_200 },
		],
		topics: ["browser-extension", "markdown"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 720,
		pushedDaysAgo: 18,
		commits30d: 4,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 1,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "audio-trim",
		description: "Fast FFmpeg wrapper for podcast silence removal and LUFS normalization",
		language: "Python",
		languages: [{ name: "Python", bytes: 68_000 }],
		topics: ["python", "ffmpeg", "audio"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 610,
		pushedDaysAgo: 21,
		commits30d: 3,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "tiny-oidc",
		description: "Minimal OIDC test issuer for local integration suites",
		language: "Go",
		languages: [{ name: "Go", bytes: 92_000 }],
		topics: ["oidc", "jwt", "testing"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 940,
		pushedDaysAgo: 25,
		commits30d: 2,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "git-scribe",
		description: "Release notes generator from conventional commits and PR labels",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 74_000 }],
		topics: ["git", "changelog", "cli"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 690,
		pushedDaysAgo: 29,
		commits30d: 2,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "ledger-sync",
		description: "Plaintext accounting importer for Beancount and CSV bank statements",
		language: "Python",
		languages: [{ name: "Python", bytes: 112_000 }],
		topics: ["beancount", "finance", "python"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 1_120,
		pushedDaysAgo: 35,
		commits30d: 0,
		ciMode: "healthy",
		releaseCount: 0,
		alertCount: 1,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "caddy-snippets",
		description: "Reusable Caddyfile blocks for local TLS dev domains",
		language: "Shell",
		languages: [{ name: "Shell", bytes: 24_000 }],
		topics: ["caddy", "tls", "devops"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "docs-vault",
		diskKiB: 320,
		pushedDaysAgo: 42,
		commits30d: 0,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "bench-sqlite-wal",
		description: "Repro benchmarks for SQLite WAL concurrency under Bun and Node",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 42_000 }],
		topics: ["sqlite", "benchmark", "bun"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: false,
		starSource: "owner",
		category: "repro",
		diskKiB: 450,
		pushedDaysAgo: 48,
		commits30d: 0,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "alexchen",
		description: "GitHub profile README and pinned project overview",
		language: "Markdown",
		languages: [{ name: "Markdown", bytes: 18_000 }],
		topics: ["profile"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: false,
		starSource: "owner",
		category: "profile",
		diskKiB: 180,
		pushedDaysAgo: 62,
		commits30d: 0,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "dns-probe",
		description: "DoH/DoT latency probe CLI with JSON output",
		language: "Rust",
		languages: [{ name: "Rust", bytes: 88_000 }],
		topics: ["dns", "rust", "cli"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 960,
		pushedDaysAgo: 74,
		commits30d: 0,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "img-optimize",
		description: "Lossless WebP/AVIF batch pipeline for static asset folders",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 54_000 }],
		topics: ["sharp", "images", "cli"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: false,
		starSource: "owner",
		category: "app",
		diskKiB: 580,
		pushedDaysAgo: 88,
		commits30d: 0,
		ciMode: "healthy",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "webhook-replay",
		description: "Signed webhook capture and deterministic replay server",
		language: "Go",
		languages: [{ name: "Go", bytes: 105_000 }],
		topics: ["webhooks", "go", "testing"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 1_040,
		pushedDaysAgo: 95,
		commits30d: 0,
		ciMode: "flaky",
		releaseCount: 0,
		alertCount: 1,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "recharts-playground",
		description: "Minimal reproduction for responsive Recharts container resize observer",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 31_000 }],
		topics: ["recharts", "repro"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: false,
		starSource: "owner",
		category: "repro",
		diskKiB: 390,
		pushedDaysAgo: 112,
		commits30d: 0,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "homelab-compose",
		description: "Docker Compose stacks for local media, registry mirror, and backups",
		language: "YAML",
		languages: [
			{ name: "YAML", bytes: 64_000 },
			{ name: "Shell", bytes: 14_000 },
		],
		topics: ["docker", "homelab"],
		isPrivate: true,
		isFork: false,
		isArchived: false,
		starred: false,
		starSource: "owner",
		category: "app",
		diskKiB: 780,
		pushedDaysAgo: 128,
		commits30d: 0,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "term-theme-pack",
		description: "Matched light and dark color palettes for Ghostty, tmux, and Neovim",
		language: "CSS",
		languages: [{ name: "CSS", bytes: 29_000 }],
		topics: ["themes", "terminal"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: false,
		starSource: "owner",
		category: "app",
		diskKiB: 310,
		pushedDaysAgo: 145,
		commits30d: 0,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "legacy-sync-v1",
		description: "Retired v1 GitHub sync prototype",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 95_000 }],
		topics: ["archived"],
		isPrivate: true,
		isFork: false,
		isArchived: true,
		starred: false,
		starSource: "owner",
		category: "app",
		diskKiB: 1_200,
		pushedDaysAgo: 210,
		commits30d: 0,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: ACCOUNT_LOGIN,
		name: "hono-fork-experiment",
		description: "Experimental middleware patch fork",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 210_000 }],
		topics: ["fork"],
		isPrivate: false,
		isFork: true,
		isArchived: false,
		starred: false,
		starSource: "owner",
		category: "derivative",
		diskKiB: 2_100,
		pushedDaysAgo: 180,
		commits30d: 0,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: "basalt-ui",
		name: "basalt",
		description: "Opinionated component library and Tailwind v4 theme preset",
		language: "TypeScript",
		languages: [
			{ name: "TypeScript", bytes: 540_000 },
			{ name: "CSS", bytes: 92_000 },
		],
		topics: ["design-system", "react", "tailwindcss"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 5_400,
		pushedDaysAgo: 1,
		commits30d: 21,
		ciMode: "healthy",
		releaseCount: 2,
		alertCount: 0,
	},
	{
		owner: "oss-labs",
		name: "d1-orm-lite",
		description: "Zero-dependency typed query builder for Cloudflare D1",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 118_000 }],
		topics: ["cloudflare", "d1", "sqlite"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 1_150,
		pushedDaysAgo: 3,
		commits30d: 9,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 0,
	},
	{
		owner: "oss-labs",
		name: "worker-cron-guard",
		description: "Idempotent distributed cron lock for Cloudflare Workers",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 64_000 }],
		topics: ["cloudflare-workers", "cron"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "agent",
		category: "app",
		diskKiB: 640,
		pushedDaysAgo: 7,
		commits30d: 6,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 0,
	},
	{
		owner: "hono-contrib",
		name: "access-jwt-verify",
		description: "Cloudflare Access JWKS verification middleware for Hono",
		language: "TypeScript",
		languages: [{ name: "TypeScript", bytes: 48_000 }],
		topics: ["hono", "cloudflare-access", "jwt"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 480,
		pushedDaysAgo: 9,
		commits30d: 4,
		ciMode: "healthy",
		releaseCount: 1,
		alertCount: 1,
	},
	{
		owner: "cli-craft",
		name: "fzf-git-worktree",
		description: "Interactive git worktree switcher powered by fzf",
		language: "Shell",
		languages: [{ name: "Shell", bytes: 28_000 }],
		topics: ["git", "fzf", "shell"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 280,
		pushedDaysAgo: 15,
		commits30d: 3,
		ciMode: "none",
		releaseCount: 0,
		alertCount: 0,
	},
	{
		owner: "rust-tools",
		name: "ripgrep-json-tui",
		description: "Fast terminal viewer for ripgrep --json search streams",
		language: "Rust",
		languages: [{ name: "Rust", bytes: 174_000 }],
		topics: ["rust", "tui", "ripgrep"],
		isPrivate: false,
		isFork: false,
		isArchived: false,
		starred: true,
		starSource: "owner",
		category: "app",
		diskKiB: 1_820,
		pushedDaysAgo: 20,
		commits30d: 5,
		ciMode: "flaky",
		releaseCount: 1,
		alertCount: 0,
	},
];

function shanghaiDay(date: Date): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
	return `${map.year}-${map.month}-${map.day}`;
}

function addDays(base: Date, deltaDays: number): Date {
	return new Date(base.getTime() + deltaDays * 86_400_000);
}

function shanghaiMidnightUtc(dayStr: string): string {
	return new Date(`${dayStr}T00:00:00+08:00`).toISOString();
}

function sqlStr(value: string | null | undefined): string {
	if (value === null || value === undefined) return "NULL";
	return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
	return sqlStr(JSON.stringify(value));
}

function shaFor(seed: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x9e3779b9;
	for (let i = 0; i < seed.length; i++) {
		const ch = seed.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0;
	}
	return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`
		.repeat(2)
		.slice(0, 40);
}

export function buildLocalSeedSql(now = new Date()): string {
	const todayStr = shanghaiDay(now);
	const yesterdayStr = shanghaiDay(addDays(now, -1));
	const windowSinceDay = shanghaiDay(addDays(now, -30));
	const windowSinceIso = shanghaiMidnightUtc(windowSinceDay);
	const windowUntilIso = shanghaiMidnightUtc(todayStr);
	const fetchedAt = new Date(`${todayStr}T03:05:12+08:00`).toISOString();
	const priorFetchedAt = new Date(`${yesterdayStr}T03:04:40+08:00`).toISOString();

	const days30: string[] = [];
	for (let i = 30; i >= 1; i--) {
		days30.push(shanghaiDay(addDays(now, -i)));
	}

	const stmts: string[] = [];
	stmts.push(
		`DELETE FROM accounts WHERE id = ${sqlStr(ACCOUNT_ID)};`,
		`INSERT INTO accounts (id, login, avatar_url, token_ciphertext, token_last4, key_version, scopes, capabilities, is_active, created_at, updated_at, last_used_at) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(ACCOUNT_LOGIN)}, ${sqlStr("https://avatars.githubusercontent.com/u/100001?v=4")}, ${sqlStr("local-demo-placeholder")}, ${sqlStr("demo")}, 1, ${sqlJson(["repo", "read:org", "read:user", "notifications"])}, ${sqlJson({ notifications: true, security: true })}, 1, ${sqlStr(addDays(now, -120).toISOString())}, ${sqlStr(fetchedAt)}, ${sqlStr(fetchedAt)});`,
	);

	// 365-day contribution calendar
	const contributionDays: { date: string; count: number }[] = [];
	for (let i = 364; i >= 0; i--) {
		const d = addDays(now, -i);
		const date = shanghaiDay(d);
		const dow = d.getUTCDay();
		const base = dow === 0 || dow === 6 ? 2 : 6;
		const count = (i * 7 + dow * 3) % 9 === 0 ? 0 : base + ((i * 5) % 8);
		contributionDays.push({ date, count });
	}
	const contributionCalendar = {
		total: contributionDays.reduce((sum, d) => sum + d.count, 0),
		days: contributionDays,
		window: { since: addDays(now, -364).toISOString(), until: fetchedAt },
	};

	const catalogReposPayload: Record<string, unknown>[] = [];
	const allIssues: Record<string, unknown>[] = [];
	const allPrs: Record<string, unknown>[] = [];
	const allAlerts: Record<string, unknown>[] = [];
	const insightRows: Record<string, unknown>[] = [];
	const factoryRepos: Record<string, unknown>[] = [];
	const excludedRepos: { name: string; reason: string }[] = [];
	const activeRepoNames: string[] = [];

	const issueTitles = [
		"Support incremental cache invalidation for D1 batch reads",
		"Reduce layout shift on mobile sidebar drawer transition",
		"Expose --json flag for machine-readable status output",
		"Handle rate-limit retry-after header in REST client",
		"Add keyboard shortcut hint in command palette",
		"Investigate sporadic timeout during large tar extraction",
		"Preserve scroll position when switching scope filter",
		"Document local TLS proxy setup for custom dev domains",
	];
	const prTitles = [
		"feat: add streaming progress indicator for batch runs",
		"fix: guard against null conclusion on pending workflow runs",
		"chore(deps): bump @nocoo/basalt from 3.3.5 to 3.3.6",
		"refactor: extract shared table pagination chrome",
		"perf: memoize daily rollup aggregation across 90d window",
		"chore(deps): update hono to 4.13.17",
	];
	const alertPackages = [
		{
			pkg: "undici",
			severity: "high",
			summary: "undici HTTP request smuggling via malformed chunk size",
			source: "dependabot",
		},
		{
			pkg: "tar",
			severity: "medium",
			summary: "node-tar path traversal on symlink extraction",
			source: "dependabot",
		},
		{
			pkg: "rollup",
			severity: "low",
			summary: "rollup DOM clobbering in bundled output",
			source: "code_scanning",
		},
		{
			pkg: "golang.org/x/net",
			severity: "critical",
			summary: "HTTP/2 rapid reset stream exhaustion",
			source: "dependabot",
		},
	];

	let repoIndex = 0;
	for (const spec of REPO_SPECS) {
		repoIndex++;
		const fullName = `${spec.owner}/${spec.name}`;
		const repoId = `R_demo_${String(repoIndex).padStart(3, "0")}`;
		const identityKey = `github:${repoId}`;
		const pushedAt = addDays(now, -spec.pushedDaysAgo).toISOString();
		const createdAt = addDays(now, -(180 + repoIndex * 9)).toISOString();
		const updatedAt = pushedAt;
		const url = `https://github.com/${fullName}`;
		const headSha = shaFor(fullName);

		const openIssuesCount =
			spec.isArchived || spec.isFork ? 0 : repoIndex % 4 === 0 ? 3 : repoIndex % 2 === 0 ? 1 : 0;
		const openPrsCount =
			spec.isArchived || spec.isFork ? 0 : repoIndex % 3 === 0 ? 2 : repoIndex % 5 === 0 ? 1 : 0;

		const repoRow = {
			id: repoId,
			name_with_owner: fullName,
			owner_login: spec.owner,
			name: spec.name,
			description: spec.description,
			url,
			primary_language: spec.language,
			visibility: spec.isPrivate ? "PRIVATE" : "PUBLIC",
			is_private: spec.isPrivate,
			is_fork: spec.isFork,
			is_archived: spec.isArchived,
			stargazer_count: spec.owner === ACCOUNT_LOGIN ? 12 + repoIndex * 4 : 420 + repoIndex * 35,
			fork_count: spec.owner === ACCOUNT_LOGIN ? repoIndex % 7 : 38 + repoIndex * 2,
			open_issues_count: openIssuesCount,
			open_prs_count: openPrsCount,
			default_branch: "main",
			pushed_at: pushedAt,
			updated_at: updatedAt,
			created_at: createdAt,
			starred: spec.starred,
			star_source: spec.starSource,
			topics: spec.topics,
			ci_status:
				spec.ciMode === "healthy"
					? "success"
					: spec.ciMode === "flaky"
						? "unstable"
						: spec.ciMode === "failing"
							? "failure"
							: null,
			alerts_count: spec.alertCount,
		};
		catalogReposPayload.push(repoRow);

		stmts.push(
			`INSERT INTO catalog_repositories (account_id, identity_key, github_id, repo, row_payload, first_seen_at, last_seen_at, removed_at, archived_changed_at, is_archived, visibility, is_fork, first_seen_source, last_source_run_id) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(identityKey)}, ${sqlStr(repoId)}, ${sqlStr(fullName)}, ${sqlJson(repoRow)}, ${sqlStr(createdAt)}, ${sqlStr(fetchedAt)}, NULL, NULL, ${spec.isArchived ? 1 : 0}, ${sqlStr(spec.isPrivate ? "PRIVATE" : "PUBLIC")}, ${spec.isFork ? 1 : 0}, 'github_catalog', ${sqlStr(RUN_ID)});`,
		);

		stmts.push(
			`INSERT INTO repo_stars (account_id, repo, starred, source, updated_at, reason) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(fullName)}, ${spec.starred ? 1 : 0}, ${sqlStr(spec.starSource)}, ${sqlStr(fetchedAt)}, ${spec.starred ? "'demo_seed'" : "NULL"});`,
		);

		stmts.push(
			`INSERT INTO refresh_catalog (account_id, repo_id, repo, discovered_day, timezone, payload, fetched_at, active) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(repoId)}, ${sqlStr(fullName)}, ${sqlStr(todayStr)}, ${sqlStr(TIMEZONE)}, ${sqlJson(repoRow)}, ${sqlStr(fetchedAt)}, 1);`,
		);

		if (repoIndex <= 8) {
			stmts.push(
				`INSERT INTO repo_meta (account_id, identity_key, created_at, created_at_source, archived_at, archived_at_source, category, category_source, exclusion_reason, exclusion_reason_source, updated_at) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(identityKey)}, ${sqlStr(createdAt)}, 'catalog', NULL, NULL, ${sqlStr(spec.category)}, 'agent', NULL, NULL, ${sqlStr(fetchedAt)});`,
			);
		}
		if (repoIndex <= 6) {
			stmts.push(
				`INSERT INTO repo_agent_state (account_id, identity_key, payload, revision, updated_at, updated_by) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(identityKey)}, ${sqlJson({ status: spec.ciMode === "failing" ? "attention" : "healthy", summary: `${spec.name} running on latest main (${headSha.slice(0, 7)})`, next_action: spec.ciMode === "failing" ? "Fix failing CI workflow on main" : null })}, ${repoIndex}, ${sqlStr(fetchedAt)}, 'local-demo-agent');`,
			);
		}

		if (spec.isArchived) {
			excludedRepos.push({ name: fullName, reason: "archived" });
			continue;
		}
		if (spec.isFork) {
			excludedRepos.push({ name: fullName, reason: "fork" });
			continue;
		}
		activeRepoNames.push(fullName);

		// Issues for this repo
		const repoIssues: Record<string, unknown>[] = [];
		const repoIssueEvents: Record<string, unknown>[] = [];
		for (let j = 0; j < openIssuesCount; j++) {
			const ageDays = j === 0 && repoIndex % 4 === 0 ? 19 : 2 + ((repoIndex + j * 3) % 12);
			const itemCreated = addDays(now, -ageDays).toISOString();
			const issueNumber = 100 + repoIndex * 10 + j;
			const title = issueTitles[(repoIndex + j) % issueTitles.length] ?? "Track follow-up task";
			const labels = j % 2 === 0 ? ["bug", "priority:high"] : ["enhancement"];
			const issueRow = {
				id: `I_${repoIndex}_${j}`,
				number: issueNumber,
				title,
				url: `${url}/issues/${issueNumber}`,
				state: "OPEN",
				author: j % 2 === 0 ? ACCOUNT_LOGIN : "contributor-lin",
				assignees: j === 0 ? [ACCOUNT_LOGIN] : [],
				labels,
				created_at: itemCreated,
				updated_at: addDays(now, -Math.min(ageDays, 1)).toISOString(),
				comments_count: 1 + ((repoIndex + j) % 5),
				name_with_owner: fullName,
			};
			repoIssues.push(issueRow);
			allIssues.push(issueRow);
			repoIssueEvents.push({
				id: `issue-${issueNumber}`,
				title: `#${issueNumber} ${title}`,
				url: issueRow.url,
				at: itemCreated,
				createdAt: itemCreated,
				closedAt: null,
				mergedAt: null,
				author: issueRow.author,
				state: "open",
				labels,
			});
		}

		// PRs for this repo
		const repoPrs: Record<string, unknown>[] = [];
		const repoPrEvents: Record<string, unknown>[] = [];
		for (let j = 0; j < openPrsCount; j++) {
			const ageDays = j === 0 && repoIndex % 3 === 0 ? 11 : 1 + ((repoIndex + j * 2) % 6);
			const itemCreated = addDays(now, -ageDays).toISOString();
			const prNumber = 200 + repoIndex * 10 + j;
			const isDep = j === 1 || repoIndex % 5 === 0;
			const isDraft = !isDep && j === 0 && repoIndex % 6 === 0;
			const reviewDecision = isDraft
				? null
				: j === 0 && repoIndex % 2 === 0
					? "CHANGES_REQUESTED"
					: j === 0
						? "REVIEW_REQUIRED"
						: "APPROVED";
			const checkState =
				spec.ciMode === "failing" && j === 0 ? "FAILURE" : isDraft ? "PENDING" : "SUCCESS";
			const title = isDep
				? (prTitles[2] ?? "chore(deps): update dependency")
				: (prTitles[(repoIndex + j) % prTitles.length] ?? "feat: update module");
			const prRow = {
				id: `PR_${repoIndex}_${j}`,
				number: prNumber,
				title,
				url: `${url}/pull/${prNumber}`,
				state: "OPEN",
				is_draft: isDraft,
				author: isDep ? "dependabot[bot]" : ACCOUNT_LOGIN,
				review_decision: reviewDecision,
				checks_state: checkState,
				additions: 24 + ((repoIndex * 17 + j * 9) % 180),
				deletions: 6 + ((repoIndex * 7 + j * 3) % 60),
				created_at: itemCreated,
				updated_at: addDays(now, -Math.min(ageDays, 1)).toISOString(),
				name_with_owner: fullName,
				bot: isDep,
				dependency: isDep,
			};
			repoPrs.push(prRow);
			allPrs.push(prRow);
			repoPrEvents.push({
				id: `pr-${prNumber}`,
				title: `#${prNumber} ${title}`,
				url: prRow.url,
				at: itemCreated,
				createdAt: itemCreated,
				closedAt: null,
				mergedAt: null,
				author: prRow.author,
				state: "open",
				draft: isDraft,
				bot: isDep,
				dependency: isDep,
				review: reviewDecision,
				checks: { state: checkState },
			});
		}

		// CI runs for this repo
		const ciRuns: Record<string, unknown>[] = [];
		const actionEvents: Record<string, unknown>[] = [];
		if (spec.ciMode !== "none") {
			const totalRuns = 10;
			for (let r = 0; r < totalRuns; r++) {
				const runAt = addDays(now, -r).toISOString();
				const runNum = repoIndex * 100 + r;
				const conclusion =
					spec.ciMode === "healthy"
						? r === 8
							? "cancelled"
							: "success"
						: spec.ciMode === "flaky"
							? r === 1 || r === 5
								? "failure"
								: "success"
							: r < 3
								? "failure"
								: "success";
				const isDependabot = r === 9;
				const wfName = isDependabot ? "Dependabot Updates" : r % 2 === 0 ? "CI" : "Quality Gate";
				const wfPath = isDependabot
					? ".github/workflows/dependabot.yml"
					: r % 2 === 0
						? ".github/workflows/ci.yml"
						: ".github/workflows/quality.yml";
				const runObj = {
					id: 900_000 + runNum,
					workflow_id: 5000 + repoIndex * 10 + (r % 2),
					name: wfName,
					workflow_name: wfName,
					event: isDependabot ? "dynamic" : r % 3 === 0 ? "pull_request" : "push",
					head_branch: r % 3 === 0 && !isDependabot ? `feat/pr-${runNum}` : "main",
					head_sha: shaFor(`${fullName}-${r}`),
					is_default_branch: isDependabot ? false : r % 3 !== 0,
					status: "completed",
					conclusion,
					run_attempt: 1,
					created_at: runAt,
					updated_at: runAt,
					run_started_at: runAt,
					duration_s: 38 + ((repoIndex * 11 + r * 7) % 140),
					html_url: `${url}/actions/runs/${900_000 + runNum}`,
					actor: isDependabot ? "dependabot[bot]" : ACCOUNT_LOGIN,
					path: wfPath,
				};
				ciRuns.push(runObj);
				actionEvents.push({
					id: `run-${900_000 + runNum}`,
					title: `${wfName} #${runNum}`,
					url: runObj.html_url,
					at: runAt,
					createdAt: runAt,
					closedAt: runAt,
					mergedAt: null,
					author: runObj.actor,
					state: "completed",
					conclusion,
					path: wfPath,
					activityRun: {
						id: runObj.id,
						workflow_id: runObj.workflow_id,
						workflow_name: wfName,
						event: runObj.event,
						head_branch: runObj.head_branch,
						head_sha: runObj.head_sha,
						status: "completed",
						conclusion,
						run_attempt: 1,
						created_at: runAt,
						updated_at: runAt,
						run_started_at: runAt,
						duration_s: runObj.duration_s,
						html_url: runObj.html_url,
						actor: runObj.actor,
						path: wfPath,
					},
				});
			}
		}

		// Releases for this repo
		const repoReleases: Record<string, unknown>[] = [];
		const releaseEvents: Record<string, unknown>[] = [];
		for (let r = 0; r < spec.releaseCount; r++) {
			const relAt = addDays(now, -(r * 7 + (repoIndex % 5))).toISOString();
			const tag = `v0.${12 - r}.${repoIndex % 9}`;
			const prerelease = r === 0 && repoIndex % 4 === 0;
			const relObj = {
				id: `rel_${repoIndex}_${r}`,
				tag_name: tag,
				name: `${spec.name} ${tag}`,
				url: `${url}/releases/tag/${tag}`,
				published_at: relAt,
				created_at: relAt,
				prerelease,
				draft: false,
				author: ACCOUNT_LOGIN,
			};
			repoReleases.push(relObj);
			releaseEvents.push({
				id: relObj.id,
				title: relObj.name,
				tag_name: tag,
				url: relObj.url,
				at: relAt,
				createdAt: relAt,
				closedAt: null,
				mergedAt: null,
				author: ACCOUNT_LOGIN,
				state: prerelease ? "prerelease" : "published",
			});
		}

		// Alerts for this repo
		const repoAlerts: Record<string, unknown>[] = [];
		const alertEvents: Record<string, unknown>[] = [];
		for (let a = 0; a < spec.alertCount; a++) {
			const sample = alertPackages[(repoIndex + a) % alertPackages.length] ?? alertPackages[0];
			if (!sample) continue;
			const alertUrl = `${url}/security/${sample.source === "dependabot" ? "dependabot" : "code-scanning"}/${a + 1}`;
			const alertRow = {
				name_with_owner: fullName,
				source: sample.source,
				severity: sample.severity,
				summary: `${sample.pkg}: ${sample.summary}`,
				url: alertUrl,
			};
			repoAlerts.push(alertRow);
			allAlerts.push(alertRow);
			alertEvents.push({
				id: `alert-${repoIndex}-${a}`,
				title: alertRow.summary,
				url: alertUrl,
				at: pushedAt,
				createdAt: pushedAt,
				closedAt: null,
				mergedAt: null,
				author: "github-security",
				state: "open",
				severity: sample.severity,
			});
		}

		// Daily metrics across 30 days for this repo
		const daysMap: Record<
			string,
			{
				commits: number;
				issueOpened: number;
				issueClosed: number;
				prOpened: number;
				prMerged: number;
				prClosed: number;
				ciSuccess: number;
				ciFailure: number;
				releases: number;
			}
		> = {};
		const commitEvents: Record<string, unknown>[] = [];
		let sumCommits = 0;
		let sumIssueOpen = 0;
		let sumIssueClose = 0;
		let sumPrOpen = 0;
		let sumPrMerge = 0;
		let sumCiSuccess = 0;
		let sumCiFailure = 0;
		let sumReleases = 0;

		for (let dIdx = 0; dIdx < days30.length; dIdx++) {
			const dayStr = days30[dIdx];
			if (!dayStr) continue;
			const activeWeight =
				spec.commits30d > 0
					? (dIdx + repoIndex) % 3 === 0
						? 0
						: Math.max(1, Math.round(spec.commits30d / 18))
					: 0;
			const dayCommits =
				spec.commits30d > 0 && dIdx >= 30 - Math.min(30, spec.commits30d) ? activeWeight : 0;
			const dayIssueOpen = spec.commits30d >= 10 && (dIdx + repoIndex) % 9 === 0 ? 1 : 0;
			const dayIssueClose = spec.commits30d >= 10 && (dIdx + repoIndex) % 11 === 0 ? 1 : 0;
			const dayPrOpen = spec.commits30d >= 8 && (dIdx + repoIndex) % 6 === 0 ? 1 : 0;
			const dayPrMerge = spec.commits30d >= 8 && (dIdx + repoIndex) % 7 === 0 ? 1 : 0;
			const dayCiSuccess = spec.ciMode !== "none" && dayCommits > 0 ? 1 + (dIdx % 2) : 0;
			const dayCiFail =
				spec.ciMode === "failing" && dayCommits > 0 && dIdx >= 25
					? 1
					: spec.ciMode === "flaky" && dIdx === 28
						? 1
						: 0;
			const dayRel = spec.releaseCount > 0 && dIdx === 29 - (repoIndex % 7) ? 1 : 0;

			daysMap[dayStr] = {
				commits: dayCommits,
				issueOpened: dayIssueOpen,
				issueClosed: dayIssueClose,
				prOpened: dayPrOpen,
				prMerged: dayPrMerge,
				prClosed: 0,
				ciSuccess: dayCiSuccess,
				ciFailure: dayCiFail,
				releases: dayRel,
			};
			sumCommits += dayCommits;
			sumIssueOpen += dayIssueOpen;
			sumIssueClose += dayIssueClose;
			sumPrOpen += dayPrOpen;
			sumPrMerge += dayPrMerge;
			sumCiSuccess += dayCiSuccess;
			sumCiFailure += dayCiFail;
			sumReleases += dayRel;

			if (dayCommits > 0 && commitEvents.length < 15) {
				const cAt = new Date(`${dayStr}T14:20:00+08:00`).toISOString();
				const cSha = shaFor(`${fullName}-${dayStr}`);
				commitEvents.push({
					id: cSha,
					title: `chore(${spec.name}): update pipeline and state sync`,
					url: `${url}/commit/${cSha}`,
					at: cAt,
					createdAt: cAt,
					closedAt: null,
					mergedAt: null,
					author: ACCOUNT_LOGIN,
					state: "committed",
				});
			}
		}

		// Dependencies between demo repos
		const dependencies: { name: string; version: string; path: string; url: string }[] = [];
		if (spec.name === "giraffe-console") {
			dependencies.push(
				{
					name: "basalt-ui/basalt",
					version: "^3.3.6",
					path: "package.json",
					url: `${url}/blob/main/package.json`,
				},
				{
					name: `${ACCOUNT_LOGIN}/base-ci-workflows`,
					version: "v2",
					path: ".github/workflows/ci.yml",
					url: `${url}/blob/main/.github/workflows/ci.yml`,
				},
				{
					name: "oss-labs/d1-orm-lite",
					version: "^1.2.0",
					path: "package.json",
					url: `${url}/blob/main/package.json`,
				},
			);
		} else if (
			spec.name === "beacon-status" ||
			spec.name === "cron-atlas" ||
			spec.name === "edge-kv-router"
		) {
			dependencies.push(
				{
					name: `${ACCOUNT_LOGIN}/basalt-kit`,
					version: "^1.4.0",
					path: "package.json",
					url: `${url}/blob/main/package.json`,
				},
				{
					name: `${ACCOUNT_LOGIN}/base-ci-workflows`,
					version: "v2",
					path: ".github/workflows/ci.yml",
					url: `${url}/blob/main/.github/workflows/ci.yml`,
				},
			);
		} else if (spec.name === "schema-diff") {
			dependencies.push({
				name: "oss-labs/d1-orm-lite",
				version: "^1.2.0",
				path: "package.json",
				url: `${url}/blob/main/package.json`,
			});
		}

		const signals: {
			kind: string;
			level: "warn" | "risk";
			label: string;
			detail: string;
			url: string;
		}[] = [];
		if (spec.ciMode === "failing") {
			signals.push({
				kind: "ci_failure",
				level: "risk",
				label: "CI 失败率偏高",
				detail: "默认分支最近连续失败",
				url: `${url}/actions`,
			});
		}
		if (openIssuesCount >= 3) {
			signals.push({
				kind: "aged_issue",
				level: "warn",
				label: "存在超过 14 天未关闭 Issue",
				detail: `${openIssuesCount} 个开放 Issue`,
				url: `${url}/issues`,
			});
		}

		const coverageEntry = (observed: number, stream: string) => ({
			status: "complete" as const,
			pages: 1,
			fetchedAt,
			source: `github:${stream}`,
			reason: null,
			observed,
			inventoryComplete: true,
			observation: {
				version: RUN_ID,
				window: { since: windowSinceIso, until: windowUntilIso, timezone: TIMEZONE },
				refreshedAt: fetchedAt,
				source: "run" as const,
				head: headSha,
			},
			completeWindows: [{ since: windowSinceIso, until: windowUntilIso, timezone: TIMEZONE }],
			availableWindows: [{ since: windowSinceIso, until: windowUntilIso, timezone: TIMEZONE }],
		});

		const factoryRepo = {
			id: repoId,
			name: fullName,
			url,
			description: spec.description,
			private: spec.isPrivate,
			diskKiB: spec.diskKiB,
			pushedAt,
			language: spec.language,
			languages: spec.languages,
			languageBytes: spec.languages.reduce((s, l) => s + l.bytes, 0),
			languagesComplete: true,
			topics: spec.topics,
			branch: "main",
			head: headSha,
			totalCommits: 40 + spec.commits30d * 4 + repoIndex * 11,
			openIssues: openIssuesCount,
			openPrs: openPrsCount,
			is_fork: spec.isFork,
			is_archived: spec.isArchived,
			metadataAt: fetchedAt,
			observation: {
				version: RUN_ID,
				window: { since: windowSinceIso, until: windowUntilIso, timezone: TIMEZONE },
				refreshedAt: fetchedAt,
				publishedAt: fetchedAt,
				metadataAt: fetchedAt,
				repo: fullName,
				source: "run" as const,
			},
			metrics: {
				commits: sumCommits,
				issueOpened: sumIssueOpen,
				issueClosed: sumIssueClose,
				prOpened: sumPrOpen,
				prMerged: sumPrMerge,
				prClosed: 0,
				ciSuccess: sumCiSuccess,
				ciFailure: sumCiFailure,
				releases: sumReleases,
				ciOther: spec.ciMode === "healthy" ? 1 : 0,
				ciPending: 0,
				agedPrs: openPrsCount > 0 && repoIndex % 3 === 0 ? 1 : 0,
				agedIssues: openIssuesCount >= 3 ? 1 : 0,
				botOpen: repoPrs.filter((p) => p.bot === true).length,
				botMerged: sumPrMerge > 0 ? 1 : 0,
				alerts: spec.alertCount,
				cycleHours: sumPrMerge > 0 ? [3.2, 6.8, 14.5].slice(0, Math.min(3, sumPrMerge)) : [],
				days: daysMap,
				authors: { [ACCOUNT_LOGIN]: sumCommits },
			},
			dependencies,
			signals,
			coverage: {
				commits: coverageEntry(commitEvents.length, "commits"),
				issues: coverageEntry(repoIssueEvents.length, "issues"),
				prs: coverageEntry(repoPrEvents.length, "prs"),
				actions: coverageEntry(actionEvents.length, "actions"),
				releases: coverageEntry(releaseEvents.length, "releases"),
				alerts: coverageEntry(alertEvents.length, "alerts"),
				dependencies: coverageEntry(dependencies.length, "dependencies"),
			},
		};
		factoryRepos.push(factoryRepo);

		stmts.push(
			`INSERT INTO refresh_repository_publications (account_id, repo_id, payload, fetched_at) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(repoId)}, ${sqlJson(factoryRepo)}, ${sqlStr(fetchedAt)});`,
		);

		// Per-stream resources for factory drilldown
		const streams: [string, unknown[]][] = [
			["commits", commitEvents],
			["issues", repoIssueEvents],
			["prs", repoPrEvents],
			["actions", actionEvents],
			["releases", releaseEvents],
			["alerts", alertEvents],
			[
				"dependencies",
				dependencies.map((dep, i) => ({
					id: `dep-${i}`,
					title: `${dep.name} (${dep.version})`,
					url: dep.url,
					at: fetchedAt,
					createdAt: fetchedAt,
					closedAt: null,
					mergedAt: null,
					author: null,
					state: "referenced",
					path: dep.path,
					version: dep.version,
				})),
			],
		];
		for (const [streamName, items] of streams) {
			const resPayload = {
				runId: RUN_ID,
				repo: fullName,
				stream: streamName,
				fetchedAt,
				ranges: [{ since: windowSinceIso, until: windowUntilIso, timezone: TIMEZONE }],
				coverage: factoryRepo.coverage[streamName as keyof typeof factoryRepo.coverage],
				items,
			};
			stmts.push(
				`INSERT INTO refresh_resources (account_id, repo_id, stream, payload, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(repoId)}, ${sqlStr(streamName)}, ${sqlJson(resPayload)}, NULL);`,
			);
		}

		// Per-repo refresh_snapshots for CI, Issues, PRs, Security, Details, and Repo Detail page
		const repoBaseLower = fullName.toLowerCase();
		const securityPayload = {
			fetched_at: fetchedAt,
			truncated: false,
			items: repoAlerts,
			features: {
				dependabot: { status: spec.alertCount > 0 ? "enabled" : "enabled" },
				code_scanning: {
					status: spec.language === "TypeScript" || spec.language === "Go" ? "enabled" : "disabled",
				},
			},
		};
		const actionsPayload = { fetched_at: fetchedAt, truncated: false, runs: ciRuns };
		const releasesPayload = { fetched_at: fetchedAt, truncated: false, releases: repoReleases };
		const issuesPayload = { fetched_at: fetchedAt, truncated: false, issues: repoIssues };
		const prsPayload = { fetched_at: fetchedAt, truncated: false, pull_requests: repoPrs };
		const trafficViews = Array.from({ length: 14 }, (_, i) => ({
			timestamp: shanghaiMidnightUtc(shanghaiDay(addDays(now, -(13 - i)))),
			count: 18 + ((repoIndex * 7 + i * 5) % 45),
			uniques: 6 + ((repoIndex * 3 + i * 2) % 18),
		}));
		const trafficClones = Array.from({ length: 14 }, (_, i) => ({
			timestamp: shanghaiMidnightUtc(shanghaiDay(addDays(now, -(13 - i)))),
			count: 4 + ((repoIndex * 3 + i * 2) % 14),
			uniques: 2 + ((repoIndex + i) % 6),
		}));
		const repoDetailPayload = {
			fetched_at: fetchedAt,
			truncated: false,
			repo: repoRow,
			languages: spec.languages,
			contributors: [
				{
					login: ACCOUNT_LOGIN,
					avatar_url: "https://avatars.githubusercontent.com/u/100001?v=4",
					contributions: 42 + spec.commits30d * 2,
				},
				{
					login: "contributor-lin",
					avatar_url: "https://avatars.githubusercontent.com/u/100002?v=4",
					contributions: 8 + (repoIndex % 15),
				},
			],
			traffic: {
				views: {
					count: trafficViews.reduce((s, v) => s + v.count, 0),
					uniques: trafficViews.reduce((s, v) => s + v.uniques, 0),
					views: trafficViews,
				},
				clones: {
					count: trafficClones.reduce((s, v) => s + v.count, 0),
					uniques: trafficClones.reduce((s, v) => s + v.uniques, 0),
					clones: trafficClones,
				},
			},
		};

		const repoSnapshots: [string, unknown][] = [
			[`repo:${repoBaseLower}`, repoDetailPayload],
			[`repo:${repoBaseLower}:details`, { fetched_at: fetchedAt, truncated: false, ...repoRow }],
			[`repo:${repoBaseLower}:actions`, actionsPayload],
			[`repo:${repoBaseLower}:releases`, releasesPayload],
			[`repo:${repoBaseLower}:issues`, issuesPayload],
			[`repo:${repoBaseLower}:prs`, prsPayload],
			[`repo:${repoBaseLower}:security`, securityPayload],
		];
		for (const [kind, payload] of repoSnapshots) {
			stmts.push(
				`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlStr(kind)}, ${sqlJson(payload)}, ${sqlStr(fetchedAt)}, NULL);`,
			);
		}

		// Insights row
		const health =
			spec.ciMode === "failing" || spec.alertCount >= 2
				? "risky"
				: spec.ciMode === "flaky" || openIssuesCount >= 3 || spec.pushedDaysAgo > 60
					? "watch"
					: "strong";
		insightRows.push({
			name_with_owner: fullName,
			open_issue_count: openIssuesCount,
			days_since_push: spec.pushedDaysAgo,
			health,
			alerts: repoAlerts,
			opportunities:
				health === "risky"
					? ["修复默认分支 CI 失败", "处理高危安全告警"]
					: health === "watch"
						? ["清理积压 Issue / 观察间歇性 CI 失败"]
						: [],
		});
	}

	// Factory publication & snapshot
	const factorySnapshot = {
		owner: ACCOUNT_LOGIN,
		account_id: ACCOUNT_ID,
		runId: RUN_ID,
		fetched_at: fetchedAt,
		status: "complete",
		truncated: false,
		requests: 142,
		rate: { resource: "graphql", remaining: 4858, resetAt: addDays(now, 0).toISOString() },
		window: { since: windowSinceIso, until: windowUntilIso, timezone: TIMEZONE },
		publication: { mixed: false, runId: RUN_ID, publishedAt: fetchedAt },
		inventory: {
			complete: true,
			total: REPO_SPECS.length,
			included: factoryRepos.length,
			excluded: excludedRepos,
		},
		contribution: contributionCalendar,
		contributionStatus: "complete",
		repos: factoryRepos,
	};

	// Activity snapshot (/today)
	const activitySnapshot = {
		account_id: ACCOUNT_ID,
		runId: RUN_ID,
		fetchedAt,
		truncated: false,
		window: {
			since: shanghaiMidnightUtc(yesterdayStr),
			until: fetchedAt,
			gap: false,
			first: false,
		},
		totals: {
			merged_prs: 4,
			dependency_prs: 1,
			other_prs: 3,
			opened_issues: 3,
			closed_issues: 2,
			releases: 2,
		},
		coverage: {
			repos: { status: "complete", truncated: false, reason: null, inventoryComplete: true },
			contributions: { status: "complete", truncated: false, reason: null },
		},
		contributions: {
			timezone: TIMEZONE,
			days: [
				{
					date: todayStr,
					since: shanghaiMidnightUtc(todayStr),
					until: fetchedAt,
					partial: true,
					count: 5,
					types: { commits: 4, prs: 1, issues: 0, reviews: 0 },
					coverage: { status: "complete", truncated: false, reason: null },
					nativeCalendar: { days: [{ date: todayStr, count: 5 }] },
				},
				{
					date: yesterdayStr,
					since: shanghaiMidnightUtc(yesterdayStr),
					until: shanghaiMidnightUtc(todayStr),
					partial: false,
					count: 11,
					types: { commits: 7, prs: 2, issues: 1, reviews: 1 },
					coverage: { status: "complete", truncated: false, reason: null },
					nativeCalendar: { days: [{ date: yesterdayStr, count: 11 }] },
				},
			],
		},
		repos: [
			{
				repo: `${ACCOUNT_LOGIN}/giraffe-console`,
				ci_runs: [
					{
						id: 991001,
						workflow_id: 5010,
						workflow_name: "CI",
						event: "push",
						head_branch: "main",
						head_sha: shaFor("giraffe-console-today"),
						is_default_branch: true,
						status: "completed",
						conclusion: "success",
						run_attempt: 1,
						created_at: fetchedAt,
						updated_at: fetchedAt,
						run_started_at: fetchedAt,
						duration_s: 48,
						html_url: `https://github.com/${ACCOUNT_LOGIN}/giraffe-console/actions/runs/991001`,
						actor: ACCOUNT_LOGIN,
						path: ".github/workflows/ci.yml",
					},
				],
				prs: {
					opened: [],
					merged: [
						{
							id: "act-pr-1",
							title: "#312 feat: support dark-mode chart tokens in factory treemap",
							url: `https://github.com/${ACCOUNT_LOGIN}/giraffe-console/pull/312`,
							at: priorFetchedAt,
							createdAt: addDays(now, -2).toISOString(),
							closedAt: priorFetchedAt,
							mergedAt: priorFetchedAt,
							merged_at: priorFetchedAt,
							merged_by: ACCOUNT_LOGIN,
							base_ref: "main",
							author: ACCOUNT_LOGIN,
							state: "merged",
							bot: false,
							dependency: false,
						},
						{
							id: "act-pr-2",
							title: "#313 chore(deps): bump @nocoo/basalt from 3.3.5 to 3.3.6",
							url: `https://github.com/${ACCOUNT_LOGIN}/giraffe-console/pull/313`,
							at: priorFetchedAt,
							createdAt: addDays(now, -1).toISOString(),
							closedAt: priorFetchedAt,
							mergedAt: priorFetchedAt,
							merged_at: priorFetchedAt,
							merged_by: ACCOUNT_LOGIN,
							base_ref: "main",
							author: "dependabot[bot]",
							state: "merged",
							bot: true,
							dependency: true,
						},
					],
					closed: [],
				},
				issues: {
					opened: [
						{
							id: "act-iss-1",
							title: "#314 Add keyboard navigation for repository matrix",
							url: `https://github.com/${ACCOUNT_LOGIN}/giraffe-console/issues/314`,
							at: priorFetchedAt,
							createdAt: priorFetchedAt,
							closedAt: null,
							mergedAt: null,
							author: ACCOUNT_LOGIN,
							state: "open",
							closed_by: null,
							state_reason: null,
							labels: ["enhancement"],
						},
					],
					closed: [
						{
							id: "act-iss-2",
							title: "#309 Fix stale cache key after star toggle",
							url: `https://github.com/${ACCOUNT_LOGIN}/giraffe-console/issues/309`,
							at: priorFetchedAt,
							createdAt: addDays(now, -4).toISOString(),
							closedAt: priorFetchedAt,
							mergedAt: null,
							author: ACCOUNT_LOGIN,
							state: "closed",
							closed_by: ACCOUNT_LOGIN,
							state_reason: "completed",
							labels: ["bug"],
						},
					],
				},
				releases: [
					{
						id: "act-rel-1",
						title: "giraffe-console v0.29.1",
						tag_name: "v0.29.1",
						url: `https://github.com/${ACCOUNT_LOGIN}/giraffe-console/releases/tag/v0.29.1`,
						at: priorFetchedAt,
						createdAt: priorFetchedAt,
						closedAt: null,
						mergedAt: null,
						author: ACCOUNT_LOGIN,
						state: "published",
					},
				],
				commits: {
					default: 4,
					other: 1,
					items: [
						{
							sha: shaFor("today-commit-1"),
							author: ACCOUNT_LOGIN,
							message: "chore(ui): tighten factory panel hints",
							at: fetchedAt,
							url: `https://github.com/${ACCOUNT_LOGIN}/giraffe-console/commit/${shaFor("today-commit-1")}`,
							branch: "main",
							is_default_branch: true,
						},
					],
				},
				deploy: {
					last_success_at: priorFetchedAt,
					runs: [
						{
							id: 991002,
							workflow_id: 5011,
							workflow_name: "Release",
							event: "push",
							head_branch: "main",
							head_sha: shaFor("giraffe-console-deploy"),
							is_default_branch: true,
							status: "completed",
							conclusion: "success",
							run_attempt: 1,
							created_at: priorFetchedAt,
							updated_at: priorFetchedAt,
							run_started_at: priorFetchedAt,
							duration_s: 62,
							html_url: `https://github.com/${ACCOUNT_LOGIN}/giraffe-console/actions/runs/991002`,
							actor: ACCOUNT_LOGIN,
							path: ".github/workflows/release.yml",
						},
					],
				},
				snapshot: {
					open_prs: null,
					open_issues: null,
					dependabot: 1,
					code_scanning: 0,
				},
				coverage: {
					commits: { status: "complete", truncated: false, reason: null },
					prs: { status: "complete", truncated: false, reason: null },
					issues: { status: "complete", truncated: false, reason: null },
					actions: { status: "complete", truncated: false, reason: null },
					releases: { status: "complete", truncated: false, reason: null },
				},
			},
		],
	};

	const notificationsPayload = {
		fetched_at: fetchedAt,
		truncated: false,
		notifications: Array.from({ length: 12 }, (_, i) => {
			const spec = REPO_SPECS[i % 10] ?? REPO_SPECS[0];
			if (!spec) throw new Error("Missing seed repo spec");
			const reasons = [
				"review_requested",
				"mention",
				"ci_activity",
				"assign",
				"state_change",
				"author",
			];
			return {
				id: String(7_000_000 + i),
				name_with_owner: `${spec.owner}/${spec.name}`,
				unread: i < 5,
				reason: reasons[i % reasons.length],
				updated_at: addDays(now, -(i % 4)).toISOString(),
				subject: {
					title: i % 2 === 0 ? prTitles[i % prTitles.length] : issueTitles[i % issueTitles.length],
					type: i % 2 === 0 ? "PullRequest" : "Issue",
					url: `https://github.com/${spec.owner}/${spec.name}/${i % 2 === 0 ? "pull" : "issues"}/${100 + i}`,
				},
				repository: {
					name_with_owner: `${spec.owner}/${spec.name}`,
					url: `https://github.com/${spec.owner}/${spec.name}`,
				},
			};
		}),
	};

	const insightsPayload = {
		account_id: ACCOUNT_ID,
		fetched_at: fetchedAt,
		truncated: false,
		alerts_incomplete: false,
		insights: insightRows,
	};

	const alertsPayload = {
		account_id: ACCOUNT_ID,
		fetched_at: fetchedAt,
		truncated: false,
		items: allAlerts,
		features: {
			dependabot: { status: "enabled" },
			code_scanning: { status: "enabled" },
		},
	};

	stmts.push(
		`INSERT INTO refresh_publications (account_id, payload, published_at) VALUES (${sqlStr(ACCOUNT_ID)}, ${sqlJson(factorySnapshot)}, ${sqlStr(fetchedAt)});`,
		`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, 'factory', ${sqlJson(factorySnapshot)}, ${sqlStr(fetchedAt)}, NULL);`,
		`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, 'activity', ${sqlJson(activitySnapshot)}, ${sqlStr(fetchedAt)}, NULL);`,
		`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, 'repos', ${sqlJson({ repos: catalogReposPayload, fetched_at: fetchedAt, truncated: false })}, ${sqlStr(fetchedAt)}, NULL);`,
		`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, 'issues', ${sqlJson({ issues: allIssues, fetched_at: fetchedAt, truncated: false })}, ${sqlStr(fetchedAt)}, NULL);`,
		`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, 'prs', ${sqlJson({ pull_requests: allPrs, fetched_at: fetchedAt, truncated: false })}, ${sqlStr(fetchedAt)}, NULL);`,
		`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, 'insights', ${sqlJson(insightsPayload)}, ${sqlStr(fetchedAt)}, NULL);`,
		`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, 'alerts', ${sqlJson(alertsPayload)}, ${sqlStr(fetchedAt)}, NULL);`,
		`INSERT INTO refresh_snapshots (account_id, kind, payload, fetched_at, content_meta) VALUES (${sqlStr(ACCOUNT_ID)}, 'notifications', ${sqlJson(notificationsPayload)}, ${sqlStr(fetchedAt)}, NULL);`,
	);

	// Refresh runs history (3 runs)
	const runs = [
		{
			id: RUN_ID,
			status: "completed",
			trigger: "scheduled",
			scheduleDay: todayStr,
			createdAt: new Date(`${todayStr}T03:00:00+08:00`).toISOString(),
			updatedAt: fetchedAt,
			completedRepos: activeRepoNames.length,
			partial: false,
			partialReasons: [],
			errorCode: null,
			requests: 142,
		},
		{
			id: PRIOR_RUN_ID,
			status: "completed",
			trigger: "scheduled",
			scheduleDay: yesterdayStr,
			createdAt: new Date(`${yesterdayStr}T03:00:00+08:00`).toISOString(),
			updatedAt: priorFetchedAt,
			completedRepos: activeRepoNames.length,
			partial: false,
			partialReasons: [],
			errorCode: null,
			requests: 136,
		},
		{
			id: PARTIAL_RUN_ID,
			status: "partial",
			trigger: "manual",
			scheduleDay: null,
			createdAt: addDays(now, -2).toISOString(),
			updatedAt: addDays(now, -2).toISOString(),
			completedRepos: activeRepoNames.length - 1,
			partial: true,
			partialReasons: [
				{
					repo: `${ACCOUNT_LOGIN}/nmem-cli`,
					codes: ["alerts:code_scanning_disabled"],
				},
			],
			errorCode: "partial_observation",
			requests: 94,
		},
	];

	for (const run of runs) {
		const runPayload = {
			id: run.id,
			accountId: ACCOUNT_ID,
			params: {
				since: yesterdayStr,
				until: todayStr,
				timezone: TIMEZONE,
				dimensions: ["commits", "issues", "prs", "actions", "releases", "alerts"],
				force: false,
			},
			trigger: run.trigger,
			status: run.status,
			phase: "done",
			repos: activeRepoNames,
			completedRepos: run.completedRepos,
			requests: run.requests,
			requestBreakdown: {
				total: run.requests,
				graphql: Math.round(run.requests * 0.65),
				rest: run.requests - Math.round(run.requests * 0.65),
				a: { graphql: 4, rest: 1 },
				b: {
					graphql: Math.round(run.requests * 0.65) - 4,
					rest: run.requests - Math.round(run.requests * 0.65) - 1,
				},
			},
			partialReasons: run.partialReasons,
			cancelRequested: false,
			partial: run.partial,
			errorCode: run.errorCode,
			createdAt: run.createdAt,
			updatedAt: run.updatedAt,
			finishedAt: run.updatedAt,
			aReused: false,
		};
		stmts.push(
			`INSERT INTO refresh_runs (id, account_id, status, trigger, schedule_day, payload, created_at, updated_at) VALUES (${sqlStr(run.id)}, ${sqlStr(ACCOUNT_ID)}, ${sqlStr(run.status)}, ${sqlStr(run.trigger)}, ${sqlStr(run.scheduleDay)}, ${sqlJson(runPayload)}, ${sqlStr(run.createdAt)}, ${sqlStr(run.updatedAt)});`,
		);
	}

	return `${stmts.join("\n")}\n`;
}
