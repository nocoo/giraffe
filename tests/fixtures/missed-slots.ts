import { beijingDayStart } from "../../apps/web/src/server/lib/schedule-admission";

export function missedSlotFixture(now: string) {
	const today = beijingDayStart(now);
	return {
		today,
		due: new Date(Date.parse(today) - 3 * 86400_000).toISOString(),
		time: "00:00",
	};
}
