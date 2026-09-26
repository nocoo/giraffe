import type {
	RefreshSchedule,
	RefreshSettings,
	ScheduleConfig,
	ScheduleKind,
} from "../../lib/refresh-schedule";
import { apiGet, apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
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
	}
	if (schedule.lastError) return "暂未启动，将自动重试";
	return schedule.nextAt
		? `下次：${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(schedule.nextAt))}`
		: "等待首次安排";
}
