export type ScheduleKind = "daily" | "weekly" | "catalog";
export type ScheduleConfig = {
	enabled: boolean;
	time: string;
	weekday: number;
	scope: "all" | "starred";
};
export type RefreshSchedule = ScheduleConfig & {
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
export const defaultSchedule = (kind: ScheduleKind): ScheduleConfig => ({
	enabled: false,
	time: kind === "daily" ? "08:00" : kind === "catalog" ? "07:00" : "04:00",
	weekday: 0,
	scope: kind === "daily" ? "starred" : "all",
});
