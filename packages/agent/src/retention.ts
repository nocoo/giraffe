import { ApiError, type GiraffeClient } from "./client.ts";
import { analysisReportSchema, type Resource } from "./contracts.ts";

export function expiredResources(reports: Resource[], jobs: Resource[]) {
	const keepReports = new Set<string>();
	const counts = new Map<string, number>();
	for (const row of [...reports].sort(
		(a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
	)) {
		const report = analysisReportSchema.safeParse(row.payload);
		if (row.type !== "github-analysis" || row.status !== "completed" || !report.success) {
			keepReports.add(row.id);
			continue;
		}
		const key = `${report.data.repository ?? "all"}:${report.data.domain}`;
		const count = counts.get(key) ?? 0;
		if (count < 2) keepReports.add(row.id);
		counts.set(key, count + 1);
	}
	const terminal = jobs
		.filter(
			(row) =>
				["github-analysis", "work-run"].includes(row.type) &&
				["completed", "attention", "failed", "cancelled"].includes(row.status),
		)
		.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id));
	const keepJobs = new Set(terminal.slice(0, 20).map((row) => row.id));
	const latest = new Set<string>();
	for (const row of terminal) {
		const key = `${row.repository ?? "all"}:${row.type}:${["failed", "attention"].includes(row.status) ? "failed" : "terminal"}`;
		if (!latest.has(key)) keepJobs.add(row.id);
		latest.add(key);
	}
	return {
		reports: reports.filter((row) => !keepReports.has(row.id)),
		jobs: terminal.filter((row) => !keepJobs.has(row.id)),
	};
}

export async function pruneRemote(client: GiraffeClient) {
	const expired = expiredResources(
		await client.list("reports", { type: "github-analysis" }),
		await client.list("jobs"),
	);
	for (const collection of ["reports", "jobs"] as const) {
		for (const item of expired[collection].slice(0, 100)) {
			try {
				await client.remove(collection, item);
			} catch (error) {
				if (!(error instanceof ApiError) || ![404, 409].includes(error.status)) throw error;
			}
		}
	}
}
