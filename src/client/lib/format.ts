export const NUM_HEAD = "text-right";
export const NUM_CELL = "text-right tabular-nums";
export const DATE_CELL = "text-right tabular-nums whitespace-nowrap text-basalt-muted-foreground";

export type CandyTone =
	| "green"
	| "amber"
	| "orange"
	| "red"
	| "rose"
	| "teal"
	| "sky"
	| "blue"
	| "purple"
	| "indigo"
	| "gray";

const CANDY_CLASS: Record<CandyTone, string> = {
	green: "border-transparent bg-[hsl(var(--basalt-accent-4))] text-[hsl(0_0%_10%)]",
	amber: "border-transparent bg-[hsl(var(--basalt-accent-6))] text-[hsl(0_0%_10%)]",
	orange: "border-transparent bg-[hsl(var(--basalt-accent-7))] text-[hsl(0_0%_10%)]",
	red: "border-transparent bg-[hsl(var(--basalt-accent-8))] text-[hsl(0_0%_10%)]",
	rose: "border-transparent bg-[hsl(var(--basalt-accent-9))] text-[hsl(0_0%_10%)]",
	teal: "border-transparent bg-[hsl(var(--basalt-accent-3))] text-[hsl(0_0%_10%)]",
	sky: "border-transparent bg-[hsl(var(--basalt-accent-2))] text-[hsl(0_0%_10%)]",
	blue: "border-transparent bg-[hsl(var(--basalt-accent-1))] text-[hsl(0_0%_10%)]",
	purple: "border-transparent bg-[hsl(var(--basalt-accent-10))] text-[hsl(0_0%_10%)]",
	indigo: "border-transparent bg-[hsl(var(--basalt-accent-11))] text-[hsl(0_0%_10%)]",
	gray: "border-transparent bg-[hsl(var(--basalt-accent-12))] text-[hsl(0_0%_10%)]",
};

export function candyClass(tone: CandyTone): string {
	return CANDY_CLASS[tone];
}

export function formatDelta(value: number | null, baselineMissing: boolean): string {
	if (baselineMissing || value === null) {
		return "—";
	}
	if (value === 0) {
		return "0";
	}
	const abs = formatCount(Math.abs(value));
	return value > 0 ? `+${abs}` : `−${abs}`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatDate(value: string | null | undefined): string {
	if (!value) {
		return "—";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "—";
	}
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatCount(value: number): string {
	return new Intl.NumberFormat("zh-CN").format(value);
}

export function formatDays(value: number): string {
	return `${formatCount(value)} 天`;
}

const LANGUAGE_COLORS: Record<string, string> = {
	TypeScript: "#3178c6",
	JavaScript: "#f1e05a",
	Python: "#3572a5",
	Go: "#00add8",
	Rust: "#dea584",
	Java: "#b07219",
	Ruby: "#701516",
	PHP: "#4f5d95",
	Swift: "#f05138",
	Kotlin: "#a97bff",
	HTML: "#e34c26",
	CSS: "#563d7c",
	SCSS: "#c6538c",
	Vue: "#41b883",
	Shell: "#89e051",
	C: "#555555",
	"C++": "#f34b7d",
	"C#": "#178600",
	Dockerfile: "#384d54",
	JSON: "#292929",
	Markdown: "#083fa1",
	YAML: "#cb171e",
};

export function languageColor(name: string): string {
	const known = LANGUAGE_COLORS[name];
	if (known) {
		return known;
	}
	let hash = 0;
	for (let i = 0; i < name.length; i += 1) {
		hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	}
	return `hsl(${hash % 360} 42% 48%)`;
}

export function initials(name: string): string {
	const trimmed = name.trim();
	if (trimmed === "") {
		return "?";
	}
	const gap = trimmed.lastIndexOf(" ");
	if (gap < 0) {
		return trimmed.slice(0, 2).toUpperCase();
	}
	return `${trimmed.slice(0, 1)}${trimmed.slice(gap + 1, gap + 2)}`.toUpperCase();
}

export function formatHealth(health: "strong" | "watch" | "risky"): string {
	if (health === "strong") {
		return "健康";
	}
	if (health === "watch") {
		return "观察";
	}
	return "风险";
}

export function healthBadgeVariant(health: "strong" | "watch" | "risky"): CandyTone {
	if (health === "strong") {
		return "green";
	}
	if (health === "watch") {
		return "amber";
	}
	return "red";
}

export function formatVisibility(value: string): string {
	const key = value.toLowerCase();
	if (key === "private") {
		return "私有";
	}
	if (key === "public") {
		return "公开";
	}
	return value;
}

export function severityBadgeVariant(severity: string): CandyTone {
	const key = severity.toLowerCase();
	if (key === "critical" || key === "high") {
		return "red";
	}
	if (key === "medium" || key === "moderate") {
		return "orange";
	}
	if (key === "low") {
		return "teal";
	}
	return "gray";
}

export function formatReview(decision: string | null): string {
	if (!decision) {
		return "—";
	}
	if (decision === "APPROVED") {
		return "已批准";
	}
	if (decision === "CHANGES_REQUESTED") {
		return "需修改";
	}
	if (decision === "REVIEW_REQUIRED") {
		return "待审查";
	}
	return decision;
}

export function reviewBadgeVariant(decision: string | null): CandyTone {
	if (decision === "APPROVED") {
		return "green";
	}
	if (decision === "CHANGES_REQUESTED") {
		return "rose";
	}
	if (decision === "REVIEW_REQUIRED") {
		return "amber";
	}
	return "gray";
}

export function visibilityBadgeVariant(value: string): CandyTone {
	const key = value.toLowerCase();
	if (key === "public") {
		return "blue";
	}
	if (key === "private") {
		return "purple";
	}
	return "gray";
}

export function opportunityLabel(value: string): string {
	if (value === "stale_push") {
		return "久未推送";
	}
	if (value === "many_issues") {
		return "大量 Issue";
	}
	if (value === "open_alerts") {
		return "有告警";
	}
	return value;
}

export function opportunityBadgeVariant(value: string): CandyTone {
	if (value === "stale_push") {
		return "amber";
	}
	if (value === "many_issues") {
		return "red";
	}
	if (value === "open_alerts") {
		return "orange";
	}
	return "gray";
}

export function reasonBadgeVariant(reason: string): CandyTone {
	if (reason === "assign" || reason === "review_requested") {
		return "sky";
	}
	if (reason === "mention" || reason === "team_mention") {
		return "purple";
	}
	if (reason === "comment" || reason === "ci_activity") {
		return "teal";
	}
	if (reason === "author" || reason === "state_change") {
		return "amber";
	}
	if (reason === "security_alert") {
		return "red";
	}
	return "gray";
}

export function sourceBadgeVariant(source: string): CandyTone {
	const key = source.toLowerCase();
	if (key.includes("dependabot")) {
		return "teal";
	}
	if (key.includes("code")) {
		return "blue";
	}
	if (key.includes("secret")) {
		return "purple";
	}
	return "gray";
}

export function conclusionBadgeVariant(conclusion: string | null): CandyTone {
	if (conclusion === "success") {
		return "green";
	}
	if (conclusion === "failure") {
		return "red";
	}
	return "gray";
}

export function takeChips<T>(items: T[], limit = 2): { shown: T[]; extra: number } {
	if (items.length <= limit) {
		return { shown: items, extra: 0 };
	}
	return { shown: items.slice(0, limit), extra: items.length - limit };
}

export function fillTextColor(color: string): "#ffffff" | "#111111" {
	const hex = color.startsWith("#") ? color.slice(1) : color;
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
		return "#ffffff";
	}
	const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
	const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
	const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
	const lin = (channel: number) =>
		channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
	const white = 1.05 / (luminance + 0.05);
	const black = (luminance + 0.05) / 0.05;
	return white >= black ? "#ffffff" : "#111111";
}

export function labelFill(color: string): string {
	return color.startsWith("#") ? color : `#${color}`;
}

export function daysBetween(fetchedAt: string, earlier: string | null): number {
	if (!earlier) {
		return 9999;
	}
	const ms = Date.parse(fetchedAt) - Date.parse(earlier);
	if (!Number.isFinite(ms)) {
		return 9999;
	}
	if (ms < 0) {
		return 0;
	}
	return Math.floor(ms / 86_400_000);
}

export function meterFilled(value: number, max: number, total = 8): number {
	if (value <= 0 || max <= 0) {
		return 0;
	}
	return Math.max(1, Math.round((value / max) * total));
}

export function freshnessFilled(days: number): number {
	if (days <= 7) {
		return 8;
	}
	if (days <= 30) {
		return 5;
	}
	if (days <= 90) {
		return 3;
	}
	return 1;
}

export function freshnessTone(days: number): string {
	if (days <= 7) {
		return "bg-basalt-heatmap-green-3";
	}
	if (days <= 30) {
		return "bg-basalt-chart-7";
	}
	if (days <= 90) {
		return "bg-basalt-chart-8";
	}
	return "bg-basalt-chart-10";
}

export function maxCount(values: number[]): number {
	let max = 0;
	for (const value of values) {
		if (value > max) {
			max = value;
		}
	}
	return max;
}

export function churnFilled(
	additions: number,
	deletions: number,
): {
	adds: number;
	dels: number;
} {
	const total = additions + deletions;
	if (total <= 0) {
		return { adds: 0, dels: 0 };
	}
	const adds = Math.round((additions / total) * 8);
	return { adds, dels: 8 - adds };
}

export function formatRunStatus(status: string): string {
	if (status === "completed") {
		return "完成";
	}
	if (status === "in_progress") {
		return "进行中";
	}
	if (status === "queued") {
		return "排队";
	}
	return status;
}

export function formatConclusion(conclusion: string | null): string {
	if (!conclusion) {
		return "—";
	}
	if (conclusion === "success") {
		return "成功";
	}
	if (conclusion === "failure") {
		return "失败";
	}
	if (conclusion === "cancelled") {
		return "取消";
	}
	if (conclusion === "skipped") {
		return "跳过";
	}
	return conclusion;
}
