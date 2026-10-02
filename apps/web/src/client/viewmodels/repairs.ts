import type { Resource } from "@nocoo/giraffe-agent/contracts";
import {
	type CronStatus,
	cronStatusSchema,
	type RepairProgress,
	type RepairStage,
	repairProgressSchema,
} from "@nocoo/giraffe-agent/repair-contracts";
import { apiGet, apiPost, apiWrite } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession, getActiveAccountId } from "./session";
export type RepairsData = {
	account_id: string;
	jobs: Resource[];
	cron: Resource | null;
	control: Resource | null;
};
export const STAGE_LABEL: Record<RepairStage, string> = {
	discovered: "已发现",
	planning: "规划中",
	preparing: "准备工作区",
	fixing: "修复中",
	checking: "执行检查",
	reviewing: "独立审查",
	signed_off: "已签核",
	pushing: "推送中",
	pushed: "已推送",
	blocked: "前置条件阻塞",
	exhausted: "轮次耗尽",
	cancelled: "已取消",
};
export const REPAIR_PHASES: RepairStage[] = [
	"discovered",
	"planning",
	"preparing",
	"fixing",
	"checking",
	"reviewing",
	"signed_off",
	"pushing",
	"pushed",
];
export function signoffMatches(value: RepairProgress) {
	const review = value.review;
	return (
		!!review &&
		review.verdict === "signoff" &&
		review.head === value.head &&
		review.contentFingerprint === value.contentFingerprint &&
		review.reviewedRound === value.round &&
		!!review.validationDigest
	);
}
export function repairLinks(value: RepairProgress) {
	let issue: string | null = null;
	try {
		const url = new URL(value.issueUrl);
		if (
			url.protocol === "https:" &&
			url.hostname === "github.com" &&
			!url.username &&
			!url.password &&
			url.pathname === `/${value.repository}/issues/${value.issueNumber}`
		)
			issue = url.href;
	} catch {}
	const branch =
		value.branch && /^giraffe\/deps-[A-Za-z0-9_-]+$/.test(value.branch)
			? `https://github.com/${value.repository}/tree/${value.branch}`
			: null;
	return { issue, branch };
}
function validZone(zone: string) {
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}
export function repairBoard(data: RepairsData, now: number) {
	const errors: string[] = [];
	const jobs: RepairProgress[] = [];
	for (const row of data.jobs) {
		const result = repairProgressSchema.safeParse(row.payload);
		if (
			!result.success ||
			row.type !== "dependency-repair" ||
			row.account_id !== data.account_id ||
			result.data.id !== row.id ||
			result.data.repository !== row.repository ||
			result.data.stage !== row.status ||
			result.data.round > result.data.maxRounds ||
			!Number.isFinite(Date.parse(result.data.updatedAt)) ||
			result.data.events.some((event) => !Number.isFinite(Date.parse(event.at)))
		) {
			errors.push(`任务 ${row.id} 数据无效或身份不一致`);
			continue;
		}
		jobs.push({
			...result.data,
			events: [...result.data.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
		});
	}
	jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.sequence - a.sequence);
	let cron: CronStatus | null = null;
	if (data.cron) {
		const parsed = cronStatusSchema.safeParse(data.cron.payload);
		if (
			parsed.success &&
			data.cron.id === "repair-cron" &&
			data.cron.type === "repair-cron" &&
			validZone(parsed.data.timezone) &&
			data.cron.account_id === data.account_id &&
			Number.isFinite(Date.parse(parsed.data.lastSeenAt))
		)
			cron = parsed.data;
		else errors.push("定时器状态格式无效");
	}
	const age = cron ? now - Date.parse(cron.lastSeenAt) : Infinity;
	const online = !!cron && age >= -60000 && age <= 45000 && cron.state !== "offline";
	let desiredPaused = cron?.paused ?? false;
	if (data.control) {
		if (
			data.control.id !== "repair-control" ||
			data.control.type !== "repair-control" ||
			data.control.account_id !== data.account_id ||
			typeof data.control.payload.paused !== "boolean"
		)
			errors.push("暂停控制记录格式无效");
		else desiredPaused = data.control.payload.paused;
	}
	const counts = {
		active: jobs.filter((j) => !["pushed", "blocked", "exhausted", "cancelled"].includes(j.stage))
			.length,
		blocked: jobs.filter((j) => j.stage === "blocked").length,
		exhausted: jobs.filter((j) => j.stage === "exhausted").length,
		pushed: jobs.filter((j) => j.stage === "pushed").length,
	};
	return {
		jobs,
		cron,
		online,
		desiredPaused,
		pausePending: !!cron && desiredPaused !== cron.paused,
		counts,
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
		record(account, "repair-cron"),
		record(account, "repair-control"),
	]);
	const jobs: Resource[] = [];
	let cursor: string | null = null;
	const seen = new Set<string>();
	let done = false;
	for (let i = 0; i < 50; i++) {
		const params = new URLSearchParams({
			type: "dependency-repair",
			limit: "100",
			...(cursor ? { cursor } : {}),
		});
		const page = await apiGet<{ account_id: string; items: Resource[]; nextCursor: string | null }>(
			`agent/accounts/${account}/jobs?${params}`,
		);
		if (
			page.account_id !== account ||
			page.items.some((r) => r.account_id !== account) ||
			getActiveAccountId() !== account
		)
			throw new Error("Account changed");
		jobs.push(...page.items);
		if (!page.nextCursor) {
			done = true;
			break;
		}
		if (seen.has(page.nextCursor)) throw new Error("Invalid pagination");
		seen.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	if (!done) throw new Error("Repair history exceeds display bound");
	if (getActiveAccountId() !== account) throw new Error("Account changed");
	return { account_id: account, jobs, cron, control };
}
export async function setRepairPaused(account: string, current: Resource | null, paused: boolean) {
	if (getActiveAccountId() !== account || (current && current.account_id !== account))
		throw new Error("Account changed");
	const path = `agent/accounts/${account}/records`;
	const patch = { status: paused ? "paused" : "enabled", payload: { paused } };
	const result = current
		? await apiWrite<{ account_id: string; item: Resource }>(`${path}/repair-control`, "PATCH", {
				revision: current.revision,
				...patch,
			})
		: await apiPost<{ account_id: string; item: Resource }>(path, {
				id: "repair-control",
				type: "repair-control",
				...patch,
				repository: null,
				source_version: null,
			});
	if (result.account_id !== account || getActiveAccountId() !== account)
		throw new Error("Account changed");
	return result.item;
}
