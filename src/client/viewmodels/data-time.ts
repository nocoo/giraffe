import type { RefreshWindow } from "../../lib/refresh-times";
import type { SnapshotFreshness } from "../../lib/snapshot-freshness";
import { formatTimeAgo } from "../lib/format";

export type DataTime = {
	label: string;
	at?: string | null | undefined;
	freshness?: SnapshotFreshness | undefined;
};

export function dataTimeSummary(sources: DataTime[], runs: RefreshWindow[], now: number) {
	const completedAt = (value: string | null | undefined) => {
		if (!value || !Number.isFinite(Date.parse(value))) return null;
		const time = Date.parse(value);
		return (
			runs.find((run) => time >= Date.parse(run.startedAt) && time <= Date.parse(run.finishedAt))
				?.finishedAt ?? value
		);
	};
	const rows = sources.map(({ label, at, freshness }) => ({
		label,
		at: completedAt(freshness ? freshness.latestAt : at),
		oldestAt: completedAt(freshness?.oldestAt),
		empty: freshness?.total === 0,
		missing: freshness?.missing ?? 0,
	}));
	const times = rows.flatMap((row) => [row.at, row.oldestAt]).filter((at) => at !== null);
	const latestAt = times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
	return {
		rows,
		latestAt,
		mixed: new Set(times.map(Date.parse)).size > 1,
		incomplete: rows.some((row) => !row.empty && (!row.at || row.missing > 0)),
		label: latestAt
			? Date.parse(latestAt) > now
				? "时间晚于本机"
				: `${formatTimeAgo(latestAt, now, true)}更新`
			: !rows.length
				? "暂无数据时间"
				: rows.every((row) => row.empty)
					? "当前范围暂无数据"
					: "尚未更新",
	};
}
