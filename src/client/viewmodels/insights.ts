import { loadKind } from "./snapshot";

export type Health = "strong" | "watch" | "risky";

export type InsightAlert = {
	name_with_owner: string;
	source: string;
	severity: string;
	summary: string;
	url: string;
};

export type InsightRow = {
	name_with_owner: string;
	open_issue_count: number;
	days_since_push: number;
	health: Health;
	alerts: InsightAlert[];
	opportunities: string[];
};

export type InsightsSnapshot = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	alerts_incomplete: boolean;
	insights: InsightRow[];
};

export function groupInsights(rows: InsightRow[]): Record<Health, InsightRow[]> {
	return {
		strong: rows.filter((row) => row.health === "strong"),
		watch: rows.filter((row) => row.health === "watch"),
		risky: rows.filter((row) => row.health === "risky"),
	};
}

export function filterInsights(rows: InsightRow[], health: Health | "all"): InsightRow[] {
	if (health === "all") {
		return rows;
	}
	return rows.filter((row) => row.health === health);
}

export function alertsIncomplete(snap: InsightsSnapshot | null): boolean {
	return snap?.alerts_incomplete === true;
}

export async function loadInsights(): Promise<InsightsSnapshot | { missing: true }> {
	return loadKind<InsightsSnapshot>("insights");
}
