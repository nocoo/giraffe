export function formatDelta(value: number | null, baselineMissing: boolean): string {
	if (baselineMissing || value === null) {
		return "—";
	}
	return String(value);
}

export function formatDate(value: string | null | undefined): string {
	if (!value) {
		return "—";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "—";
	}
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
}

export function formatCount(value: number): string {
	return new Intl.NumberFormat("zh-CN").format(value);
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
