import type {
	RefreshSchedule,
	RefreshSettings,
	ScheduleConfig,
	ScheduleKind,
} from "../../lib/refresh-schedule";
import { apiGet, apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { formatDate } from "../lib/format";
import { getActiveAccountId } from "./session";
export async function loadRefreshSettings(account: string): Promise<RefreshSettings | null> {
	const result = await apiGet<RefreshSettings>("refresh/settings");
	return result.account_id === account && getActiveAccountId() === account ? result : null;
}
export async function saveRefreshSchedule(
	account: string,
	kind: ScheduleKind,
	config: ScheduleConfig,
): Promise<RefreshSettings> {
	if (getActiveAccountId() !== account)
		throw new ApiError(409, "account_conflict", "account changed");
	const result = await apiPost<RefreshSettings>(`refresh/schedules/${kind}`, {
		account_id: account,
		...config,
	});
	if (result.account_id !== account || getActiveAccountId() !== account)
		throw new ApiError(409, "account_conflict", "account changed");
	return result;
}
export function scheduleStatus(schedule: RefreshSchedule): string {
	if (!schedule.enabled) return "已停用";
	switch (schedule.lastError) {
		case "no_starred_repositories":
			return "上次跳过：没有星标仓库";
		case "account_conflict":
		case "refresh_cooldown":
			return "等待已有任务或冷却结束";
		case "catalog_incomplete":
			return "等待同步仓库列表";
		case "catalog_pending":
			return "等待仓库列表同步完成";
	}
	if (schedule.lastError) return "暂未启动，将自动重试";
	return schedule.nextAt ? `下次：${formatDate(schedule.nextAt)}（本地时间）` : "等待首次安排";
}
