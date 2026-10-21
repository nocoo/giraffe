export type ScheduleKind = "daily" | "weekly" | "catalog";
export type ScheduleConfig = {
	enabled: boolean;
	time: string;
	times?: string[];
	weekday: number;
	scope: "all" | "starred";
};
export type RefreshSchedule = ScheduleConfig & {
	times: string[];
	kind: ScheduleKind;
	nextAt: string | null;
	lastRunId: string | null;
	lastError: string | null;
};
export type RefreshSettings = {
	account_id: string;
	schedules: RefreshSchedule[];
	starred: string[];
};
export const MAX_SCHEDULE_TIMES = 6;
export const defaultSchedule = (kind: ScheduleKind): ScheduleConfig & { times: string[] } => {
	const time = kind === "daily" ? "08:00" : kind === "catalog" ? "07:00" : "04:00";
	return {
		enabled: false,
		time,
		times: [time],
		weekday: 0,
		scope: kind === "daily" ? "starred" : "all",
	};
};
