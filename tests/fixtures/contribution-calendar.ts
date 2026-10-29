import { contributionDates } from "../../apps/web/src/server/lib/factory-contributions";
import { contributionWindow } from "../../apps/web/src/server/lib/refresh-calendar";

export function annualContributionCalendar(anchor: string, count = 0) {
	const window = contributionWindow(anchor);
	const days = contributionDates(window.since.slice(0, 10), window.until.slice(0, 10));
	return {
		window,
		calendar: {
			totalContributions: days.length * count,
			weeks: [{ contributionDays: days.map((date) => ({ date, contributionCount: count })) }],
		},
	};
}
