import type { Resource } from "@nocoo/giraffe-agent/contracts";
import { cronStatusSchema, workRunSchema } from "@nocoo/giraffe-agent/work-contracts";
import { apiGet, apiPost, apiWrite } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession, getActiveAccountId } from "./session";

export type RepairsData = {
	account_id: string;
	jobs: Resource[];
	cron: Resource | null;
	control: Resource | null;
};
export function repairBoard(data: RepairsData, now: number) {
	const errors: string[] = [];
	const jobs = data.jobs
		.flatMap((row) => {
			const parsed = workRunSchema.safeParse(row.payload);
			if (!parsed.success || row.type !== "work-run" || row.account_id !== data.account_id) {
				errors.push(`任务 ${row.id} 数据无效`);
				return [];
			}
			return [{ ...row, ...parsed.data }];
		})
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	const parsed = cronStatusSchema.safeParse(data.cron?.payload);
	const cron =
		parsed.success && data.cron?.account_id === data.account_id && data.cron.type === "work-cron"
			? parsed.data
			: null;
	if (data.cron && !cron) errors.push("定时器状态无效");
	const age = cron ? now - Date.parse(cron.lastSeenAt) : Infinity;
	const online = !!cron && age >= -60000 && age <= 45000 && cron.state !== "offline";
	const desiredPaused =
		data.control?.account_id === data.account_id && typeof data.control.payload.paused === "boolean"
			? data.control.payload.paused
			: (cron?.paused ?? false);
	return {
		jobs,
		cron,
		online,
		desiredPaused,
		pausePending: !!cron && desiredPaused !== cron.paused,
		errors,
	};
}
async function record(account: string, id: string): Promise<Resource | null> {
	try {
		const response = await apiGet<{ account_id: string; item: Resource }>(
			`agent/accounts/${account}/records/${id}`,
		);
		if (response.account_id !== account || response.item.account_id !== account)
			throw new Error("Account changed");
		return response.item;
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return null;
		throw error;
	}
}
export async function loadRepairs(): Promise<RepairsData> {
	const account = await ensureSession();
	const [cron, control] = await Promise.all([
		record(account, "work-cron"),
		record(account, "work-control"),
	]);
	const jobs: Resource[] = [];
	let cursor: string | null = null;
	const seen = new Set<string>();
	for (let pageIndex = 0; pageIndex < 50; pageIndex++) {
		const params = new URLSearchParams({
			type: "work-run",
			limit: "100",
			...(cursor ? { cursor } : {}),
		});
		const page = await apiGet<{ account_id: string; items: Resource[]; nextCursor: string | null }>(
			`agent/accounts/${account}/jobs?${params}`,
		);
		if (
			page.account_id !== account ||
			page.items.some((row) => row.account_id !== account) ||
			getActiveAccountId() !== account
		)
			throw new Error("Account changed");
		jobs.push(...page.items);
		if (!page.nextCursor) return { account_id: account, jobs, cron, control };
		if (seen.has(page.nextCursor)) throw new Error("Invalid pagination");
		seen.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	throw new Error("Work history exceeds display bound");
}
export async function setRepairPaused(account: string, current: Resource | null, paused: boolean) {
	if (getActiveAccountId() !== account || (current && current.account_id !== account))
		throw new Error("Account changed");
	const path = `agent/accounts/${account}/records`;
	const patch = { status: paused ? "paused" : "enabled", payload: { paused } };
	const result = current
		? await apiWrite<{ account_id: string; item: Resource }>(`${path}/work-control`, "PATCH", {
				revision: current.revision,
				...patch,
			})
		: await apiPost<{ account_id: string; item: Resource }>(path, {
				id: "work-control",
				type: "work-control",
				...patch,
				repository: null,
				source_version: null,
			});
	if (result.account_id !== account || getActiveAccountId() !== account)
		throw new Error("Account changed");
	return result.item;
}
