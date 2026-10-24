import { TooltipProvider } from "@nocoo/basalt";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	activityFixture,
	activityPr,
	activityRun,
} from "../../../../../tests/e2e/activity-fixtures";
import type { ActivitySnapshot } from "../../lib/activity-types";
import { ActivityContent } from "./activity-panels";

function render(snapshot: ActivitySnapshot, repository = false) {
	return renderToStaticMarkup(
		<TooltipProvider>
			<ActivityContent snapshot={snapshot} repository={repository} />
		</TooltipProvider>,
	);
}

describe("activity saved-publication content", () => {
	it("labels delayed default commits by their original window without adding to current counts", () => {
		const snapshot = activityFixture();
		const repo = snapshot.repos[0];
		if (!repo) throw new Error("Missing repository fixture");
		repo.commits.deferred = [
			{
				runId: "bootstrap",
				window: { ...snapshot.window, until: "2020-01-02T00:00:00.000Z" },
				items: [
					{
						sha: "old",
						author: null,
						message: "Old work",
						at: null,
						url: "",
						branch: "main",
						is_default_branch: true,
					},
				],
			},
		];
		const html = render(snapshot, true);
		expect(html).toContain("补录 1 个默认分支提交");
		expect(html).toContain("不计入本窗口");
		expect(html).toContain('dateTime="2020-01-02T00:00:00.000Z"');
	});
	it("shows exact window, data time and Beijing contribution bounds without inventing unknown counts", () => {
		const html = render(activityFixture());
		expect(html).toContain('dateTime="2026-10-21T21:00:00.000Z"');
		expect(html).toContain('dateTime="2026-10-22T21:00:00.000Z"');
		expect(html).toContain("Asia/Shanghai");
		expect(html).toContain("数据时间");
		expect(html).toContain("发布版本（不含独立标签）");
		expect(html).toContain("2026-10-22");
		expect(html).toContain("2026-10-23");
		expect(html).toContain("GitHub reported contributions（请求区间）");
		expect(html).toContain("2026-10-21");
		expect(html).toContain("GitHub 原生日历（github，未转换时区）");
		expect(html).toContain("当天未结束");
		expect(html).toContain("未知");
		expect(html).toContain("窗口内没有记录");
	});

	it("warns separately about a stretched gap, first run and truncated evidence", () => {
		const snap = activityFixture();
		snap.window.gap = true;
		snap.window.first = true;
		snap.truncated = true;
		const html = render(snap);
		expect(html).toContain("窗口有间隔");
		expect(html).toContain("首次窗口");
		expect(html).toContain("数据已截断");
		expect(html).not.toContain("窗口内没有记录");
	});

	it("does not call a capacity-omitted repository unselected or empty", () => {
		const snapshot = activityFixture();
		snapshot.repos = [];
		snapshot.truncated = true;
		snapshot.coverage.repos = { status: "partial", truncated: true, reason: "page capacity" };
		const html = render(snapshot, true);
		expect(html).toContain("该仓库的活动记录未完整保存");
		expect(html).not.toContain("该仓库未包含在当次快速刷新中");
	});

	it("renders activity repository destinations and independent security null values", () => {
		const snap = activityFixture();
		const repo = snap.repos[0];
		if (!repo) throw new Error("Missing fixture repository");
		repo.prs.merged = [activityPr()];
		repo.ci_runs = [activityRun()];
		repo.deploy.runs = [activityRun()];
		const html = render(snap, true);
		expect(html).toContain('href="/repos/octocat/hello-world"');
		expect(html).toContain("Keep current-run activity readable");
		expect(html).toContain("Dependabot");
		expect(html).toContain("code scanning");
		expect(html).toContain("未知");
		expect(html).toContain("最近成功部署");
		expect(html).not.toContain("贡献绿格");
	});

	it("keeps a reported contribution total exact when its composition is incomplete", () => {
		const snapshot = activityFixture();
		const day = snapshot.contributions?.days[0];
		if (!day) throw new Error("Missing contribution fixture");
		day.coverage = { status: "partial", truncated: false, reason: "composition incomplete" };
		day.types.commits = null;
		const html = render(snapshot);
		expect(html).toContain("GitHub reported contributions（请求区间）");
		expect(html).toContain('tabular-nums">8</p>');
		expect(html).not.toContain("≥ 8");
		expect(html).toContain("贡献来源不完整或未知");
	});
});
