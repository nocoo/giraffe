import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssessmentDigest } from "../../lib/assessment-digest";
import type { CiRepo, CiStream } from "./ci";
import {
	aiCoverage,
	type FocusSources,
	focusFindings,
	focusRanking,
	loadFocusSources,
} from "./focus";
import type { InsightRow } from "./insights";
import type { IssueRow } from "./issues";
import type { PullRow } from "./pulls";

const now = "2026-09-24T00:00:00.000Z";
const ago = (days: number) => new Date(Date.parse(now) - days * 86_400_000).toISOString();
const row = (name: string, over: Partial<InsightRow> = {}): InsightRow => ({
	name_with_owner: name,
	open_issue_count: 0,
	days_since_push: 1,
	health: "strong",
	alerts: [],
	opportunities: [],
	...over,
});
const issue = (repo: string, days: number, labels: string[] = []): IssueRow => ({
	name_with_owner: repo,
	number: 1,
	title: "t",
	url: "u",
	created_at: ago(days),
	updated_at: ago(days),
	author_login: "x",
	labels: labels.map((name) => ({ name, color: "fff" })),
	comments_count: 0,
});
const pull = (repo: string, over: Partial<PullRow> = {}): PullRow => ({
	name_with_owner: repo,
	number: 1,
	title: "t",
	url: "u",
	created_at: ago(1),
	updated_at: ago(1),
	author_login: "nocoo",
	is_draft: false,
	review_decision: null,
	additions: 1,
	deletions: 1,
	base_ref: "main",
	head_ref: "x",
	...over,
});
const assessment = (repo: string, over: Partial<AssessmentDigest> = {}): AssessmentDigest => ({
	repo,
	status: "complete",
	current: true,
	reportAt: now,
	overall: "healthy",
	sections: {
		security: "healthy",
		pullRequests: "healthy",
		issues: "healthy",
		delivery: "healthy",
	},
	trend: "steady",
	actions: [],
	flags: [],
	error: null,
	...over,
});
const stream = (repo: string, over: Partial<CiStream> = {}) =>
	({
		repo,
		workflow: "CI",
		branch: "main",
		scope: "main",
		verdict: "broken",
		reason: "连续 3 次失败",
		streak: 3,
		recurring: false,
		...over,
	}) as CiStream;
const ciRepo = (repo: string, over: Partial<CiRepo> = {}) =>
	({ repo, release: null, ...over }) as CiRepo;
const sources = (over: Partial<FocusSources>): FocusSources => ({
	rows: [],
	issues: [],
	pulls: [],
	ci: null,
	assessments: null,
	fetchedAt: now,
	...over,
});

describe("focus ranking", () => {
	it("combines AI, Jev, CI, alerts and work into ranked reasons", () => {
		const ranked = focusRanking(
			sources({
				rows: [
					row("nocoo/a", {
						alerts: [
							{
								name_with_owner: "nocoo/a",
								source: "d",
								severity: "critical",
								summary: "",
								url: "",
							},
						],
					}),
					row("nocoo/b", { open_issue_count: 25 }),
					row("nocoo/c"),
					row("nocoo/quiet"),
				],
				issues: [issue("nocoo/a", 40, ["security"]), issue("nocoo/b", 2)],
				pulls: [
					pull("nocoo/b", { author_login: "friend", updated_at: ago(20) }),
					pull("nocoo/b", { author_login: "dependabot[bot]", review_decision: "REVIEW_REQUIRED" }),
					pull("nocoo/b", {
						is_draft: true,
						review_decision: "CHANGES_REQUESTED",
						author_login: null,
					}),
				],
				ci: {
					repos: [
						ciRepo("nocoo/c", {
							release: { pipeline: "broken", latest: "v1" } as CiRepo["release"],
						}),
					],
					streams: [
						stream("nocoo/c"),
						stream("nocoo/c", { workflow: "Bot", scope: "bot" }),
						stream("nocoo/c", { workflow: "Branch", scope: "branch" }),
					],
				},
				assessments: {
					account_id: "a",
					fetched_at: now,
					truncated: false,
					configured: true,
					items: [
						assessment("NOCOO/A", {
							overall: "urgent",
							sections: {
								security: "urgent",
								pullRequests: "attention",
								issues: "healthy",
								delivery: "healthy",
							},
							trend: "slowing",
							actions: [
								{ priority: "now", title: "修复" },
								{ priority: "next", title: "跟进" },
								{ priority: "next", title: "其次" },
							],
							flags: [
								{ id: "security_urgency", choice: "urgent", uncertain: false },
								{ id: "item_issues_0", choice: "urgent", uncertain: true },
								{ id: "issue_flow", choice: "urgent", uncertain: false },
								{ id: "blocking_issues", choice: "urgent", uncertain: false },
								{ id: "review_backlog", choice: "review", uncertain: false },
								{ id: "x", choice: "review", uncertain: true },
								{ id: "y", choice: "review", uncertain: false },
								{ id: "z", choice: "review", uncertain: false },
							],
						}),
					],
				},
			}),
		);
		expect(ranked.map((r) => r.repo)).toEqual(["nocoo/a", "nocoo/c", "nocoo/b"]);
		const [a, c, b] = ranked;
		expect(a).toMatchObject({
			level: "urgent",
			primary: "security",
			ai: { overall: "urgent", current: true },
		});
		expect(a?.reasons[0]?.text).toBe("AI 总评：优先处理");
		expect(a?.reasons.map((r) => r.text)).toEqual(
			expect.arrayContaining([
				"1 个高危/严重安全告警",
				"1 个安全相关 Issue 未关闭",
				"1 个 Issue 超过 30 天未关闭",
				"AI 判定安全需优先处理",
				"AI 判定PR需要关注",
				"AI 观察到交付放缓",
				"立即：修复",
				"接下来：其次",
				"Jev：安全风险需立即处理",
				"Jev：单项事项需立即处理（低置信）",
				"Jev：PR 审查积压需人工判断",
			]),
		);
		expect(a?.reasons.filter((r) => r.text.includes("需立即处理"))).toHaveLength(3);
		expect(a?.reasons.filter((r) => r.text.includes("需人工判断"))).toHaveLength(3);
		expect(c).toMatchObject({ level: "urgent", primary: "delivery", ai: null });
		expect(c?.reasons.map((r) => r.text)).toEqual([
			"CI 连续 3 次失败",
			"发布流水线失败，最新版本 v1",
		]);
		expect(b?.reasons.map((r) => r.text)).toEqual([
			"25 个 open Issue 积压",
			"1 个外部贡献者 PR 等待处理",
			"1 个 PR 超过 14 天无更新",
			"1 个 PR 待审查或需修改",
		]);
		expect(b).toMatchObject({ issues: 1, pulls: 3, level: "attention" });
		expect(focusRanking(sources({ rows: [row("a/b")] }))).toEqual([]);
	});

	it("discounts stale reports, notes failed runs and falls back to snapshot counts", () => {
		const ranked = focusRanking(
			sources({
				rows: [
					row("o/stale", {
						alerts: [
							{ name_with_owner: "o/stale", source: "d", severity: "low", summary: "", url: "" },
						],
					}),
					row("o/failed", { days_since_push: 9999, open_issue_count: 3 }),
					row("o/old", { days_since_push: 200 }),
					row("o/never", { days_since_push: 9999 }),
					row("o/pending", { days_since_push: 120 }),
					row("o/flaky"),
				],
				issues: null,
				pulls: null,
				ci: {
					repos: [
						ciRepo("o/flaky", {
							release: { pipeline: "broken", latest: null } as CiRepo["release"],
						}),
						ciRepo("o/stale", { release: { pipeline: "healthy" } as CiRepo["release"] }),
					],
					streams: [
						stream("o/flaky", { verdict: "flaky", recurring: true, workflow: "Deploy" }),
						stream("o/stale", { verdict: "broken", scope: "branch" }),
					],
				},
				assessments: {
					account_id: "a",
					fetched_at: now,
					truncated: false,
					configured: true,
					items: [
						assessment("o/stale", {
							current: false,
							overall: "attention",
							actions: [{ priority: "next", title: "t" }],
						}),
						assessment("o/failed", {
							status: "failed",
							overall: null,
							sections: null,
							trend: null,
						}),
					],
				},
			}),
			3,
		);
		expect(ranked).toHaveLength(3);
		const stale = ranked.find((r) => r.repo === "o/stale");
		expect(stale?.reasons.map((r) => r.text)).toEqual([
			"AI 总评：需要关注（基于旧版本）",
			"1 个安全告警",
			"接下来：t",
		]);
		expect(stale?.score).toBe(19);
		const failed = ranked.find((r) => r.repo === "o/failed");
		expect(failed?.reasons.map((r) => r.text)).toEqual([
			"AI 评估失败，结论缺失需人工查看",
			"没有推送记录",
		]);
		expect(failed?.primary).toBe("activity");
		expect(ranked.find((r) => r.repo === "o/flaky")?.reasons.map((r) => r.text)).toEqual([
			"Deploy 反复失败（1 条工作流）",
			"发布流水线失败，尚无成功发布",
		]);
		const all = focusRanking(
			sources({
				rows: [
					row("o/old", { days_since_push: 200 }),
					row("o/never", { days_since_push: 9999 }),
					row("o/pending", { days_since_push: 120 }),
				],
				issues: [issue("o/pending", 1), issue("o/never", 1)],
			}),
		);
		expect(Object.fromEntries(all.map((r) => [r.repo, r.reasons[0]?.text]))).toEqual({
			"o/never": "从未推送，仍有 1 项待办",
			"o/pending": "120 天未推送，仍有 1 项待办",
			"o/old": "200 天未推送",
		});
		expect(
			focusRanking(sources({ rows: [row("o/x", { days_since_push: 9999 })] }))[0]?.reasons[0]?.text,
		).toBe("没有推送记录");
		expect(focusRanking(sources({ rows: [row("o/x", { days_since_push: 200 })] }))[0]?.level).toBe(
			"watch",
		);
	});
});

describe("focus findings", () => {
	it("reports blocked delivery, concentration, dependency load and coverage gaps", () => {
		const repos = ["a", "b", "c", "d", "e", "f"].map((n) => `nocoo/${n}`);
		const issues = [
			...Array.from({ length: 12 }, () => issue("nocoo/a", 1, ["dependencies"])),
			...Array.from({ length: 2 }, () => issue("nocoo/b", 9)),
			issue("nocoo/c", 1),
			issue("nocoo/d", 1),
			issue("nocoo/e", 1),
			issue("nocoo/f", 1),
		];
		const findings = focusFindings(
			sources({
				rows: repos.map((r, i) =>
					row(r, {
						days_since_push: i < 2 ? 100 : 1,
						alerts:
							i === 0
								? [{ name_with_owner: r, source: "d", severity: "high", summary: "", url: "" }]
								: [],
					}),
				),
				issues,
				pulls: [
					pull("nocoo/a", { author_login: "friend" }),
					pull("nocoo/a", { author_login: null }),
				],
				ci: { repos: [], streams: [stream("nocoo/a"), stream("nocoo/b", { scope: "branch" })] },
				assessments: {
					account_id: "a",
					fetched_at: now,
					truncated: false,
					configured: true,
					items: [
						assessment("nocoo/a", { overall: "urgent" }),
						assessment("nocoo/b", { current: false }),
						assessment("nocoo/c", { status: "failed", current: false, overall: null }),
					],
				},
			}),
		);
		expect(findings.map((f) => f.text)).toEqual([
			"1 个仓库默认分支 CI 持续失败，交付被阻塞",
			"1 个仓库存在高危或严重安全告警",
			"AI 将 1 个仓库评为优先处理",
			"67% 的 open Issue（12 个）是依赖更新，分布在 1 个仓库，适合批量合并处理",
			"本周新增 16 个仍未关闭的 Issue，上周为 2 个，积压在加速",
			"Issue 高度集中：前 3 个仓库占 83%",
			"1 个外部贡献者 PR 等待回复，及时审查有助于留住贡献者",
			"2 个参与统计的仓库超过 90 天未推送，可考虑归档或排除出统计",
			"AI 评估覆盖不完整：3 个没有报告，1 个基于旧版本，1 个失败；刷新仓库后会重新评估",
		]);
		expect(findings[0]?.tone).toBe("red");
		expect(aiCoverage(sources({ rows: repos.map((r) => row(r)) }))).toEqual({
			configured: false,
			current: 0,
			stale: 0,
			failed: 0,
			total: 6,
		});
	});

	it("stays quiet without evidence", () => {
		expect(focusFindings(sources({ rows: [row("a/b")], issues: null, pulls: null }))).toEqual([]);
		expect(
			focusFindings(
				sources({
					rows: [row("a/b")],
					issues: [
						issue("a/b", 1, ["dependencies"]),
						issue("a/b", 1),
						issue("a/b", 1),
						issue("a/b", 1),
					],
					assessments: {
						account_id: "a",
						fetched_at: now,
						truncated: false,
						configured: true,
						items: [assessment("a/b")],
					},
				}),
			),
		).toEqual([]);
	});
});

describe("focus sources", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("loads optional CI and AI data without failing the page", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "/api/me") return Response.json({ email: "e" });
				if (url === "/api/accounts")
					return Response.json({ accounts: [{ id: "acct", login: "n", is_active: true }] });
				if (url === "/api/ci")
					return Response.json(
						{ error: { code: "snapshot_missing", message: "m" } },
						{ status: 409 },
					);
				if (url === "/api/insights/assessments")
					return Response.json({ account_id: "acct", configured: true, items: [] });
				throw new Error(url);
			}),
		);
		expect(await loadFocusSources()).toEqual({
			ci: null,
			assessments: { account_id: "acct", configured: true, items: [] },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("offline"))),
		);
		expect(await loadFocusSources()).toEqual({ ci: null, assessments: null });
	});
});
