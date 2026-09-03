export const NUM_HEAD = "text-right";
export const NUM_CELL = "text-right tabular-nums";
export const DATE_CELL = "text-right tabular-nums whitespace-nowrap text-basalt-muted-foreground";

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

export function healthBadgeVariant(
	health: "strong" | "watch" | "risky",
): "success" | "warning" | "error" {
	if (health === "strong") {
		return "success";
	}
	if (health === "watch") {
		return "warning";
	}
	return "error";
}

export function formatVisibility(value: string): string {
	if (value === "private") {
		return "私有";
	}
	if (value === "public") {
		return "公开";
	}
	return value;
}

export function severityBadgeVariant(
	severity: string,
): "error" | "warning" | "secondary" | "outline" {
	const key = severity.toLowerCase();
	if (key === "critical" || key === "high") {
		return "error";
	}
	if (key === "medium" || key === "moderate") {
		return "warning";
	}
	if (key === "low") {
		return "secondary";
	}
	return "outline";
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

export function reviewBadgeVariant(
	decision: string | null,
): "success" | "warning" | "secondary" | "outline" {
	if (decision === "APPROVED") {
		return "success";
	}
	if (decision === "CHANGES_REQUESTED") {
		return "warning";
	}
	if (decision === "REVIEW_REQUIRED") {
		return "secondary";
	}
	return "outline";
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
