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
	const times = config.times ? [...new Set(config.times)].sort() : null;
	const result = await apiPost<RefreshSettings>(`refresh/schedules/${kind}`, {
		account_id: account,
		...config,
		...(times ? { times, time: times[0] } : {}),
	});
	if (result.account_id !== account || getActiveAccountId() !== account)
		throw new ApiError(409, "account_conflict", "account changed");
	return result;
}
export function scheduleStatus(schedule: RefreshSchedule): string {
	if (!schedule.enabled) return "已停用";
	switch (schedule.lastError) {
		case "run_timed_out":
			return "上次刷新超时，账号锁已释放；请查看执行记录";
		case "scheduled_slots_missed":
			return "曾错过调度时间，已保留历史记录";
		case "scheduled_slot_missed":
			return "曾错过北京时间当日启动时限，已单独保留失败记录";
		case "catalog_preparation_failed":
			return "前置仓库列表同步失败，目标刷新已保留失败记录";
		case "schedule_deferred":
			return "等待更高优先级的调度，当前时段仍保留";
		case "schedule_backlog":
			return "历史时段正在逐条处理，剩余时段已保留";
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
