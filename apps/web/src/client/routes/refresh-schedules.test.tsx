import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { RefreshSchedules } from "./refresh-schedules";

it("explains retained occurrences and the daily admission deadline", () => {
	const markup = renderToStaticMarkup(<RefreshSchedules account="fixture" onHistory={() => {}} />);
	expect(markup).toContain("未处理时段会逐条保留");
	expect(markup).toContain("每日任务超过北京时间当日启动时限会单独记录失败");
	expect(markup).not.toContain("仅尝试最新时段");
});
