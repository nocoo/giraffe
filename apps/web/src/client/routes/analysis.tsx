import { Button, Link, Tabs, TabsList, TabsTrigger } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Meter } from "@nocoo/basalt/components/meter";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Activity,
	ArrowUpRight,
	CheckCircle2,
	Clock3,
	GitPullRequest,
	Layers3,
	ListChecks,
	TriangleAlert,
	Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { AnalysisReport, Domain } from "../../lib/analysis-contracts";
import { GithubDailyCard } from "../components/github-daily";
import { CandyBadge } from "../components/layout/candy-badge";
import { DataTimeSource } from "../components/layout/data-time";
import { SelectField } from "../components/layout/select-field";
import { useAnalysisRead } from "../components/layout/use-analysis-read";
import { formatPreciseDate, formatTimeAgo } from "../lib/format";
import {
	type AnalysisData,
	analysisState,
	DOMAIN_LABEL,
	loadAnalysis,
	safeEvidenceUrl,
	VERDICT_LABEL,
} from "../viewmodels/analysis";

const ICONS = { issues: ListChecks, prs: GitPullRequest, ci: Workflow, cd: Layers3 };
const TONES = { pass: "green", attention: "amber", fail: "red", unknown: "gray" } as const;
const PRIORITIES = { now: "立即", next: "随后", later: "稍后" };
export function AnalysisPage() {
	const [params, setParams] = useSearchParams();
	const repository = params.get("repo") || null;
	const [domain, setDomain] = useState<Domain>("issues");
	const [data, setData] = useState<AnalysisData | null>(null);
	const repos = data?.repositories ?? [];
	const [error, setError] = useState("");
	const [now, setNow] = useState(Date.now);
	useAnalysisRead(
		loadAnalysis,
		(value) => {
			setData(value);
			setError("");
		},
		() => setError("暂时无法读取分析数据，保留上次结果；正在重试。"),
	);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 15000);
		return () => {
			clearInterval(timer);
		};
	}, []);
	const board = useMemo(
		() => (data ? analysisState(data, repository, now) : null),
		[data, repository, now],
	);
	const card = board?.cards.find((c) => c.domain === domain);
	const report = card?.report;
	const lastRun = board?.lastRun;
	return (
		<div className="space-y-4" data-testid="analysis-desk">
			<PageHeader
				title="分析台"
				description="通过 API 保存的分析判断与依据，和 GitHub 原始事实分开查看"
				actions={
					<SelectField
						label="分析范围"
						value={repository ?? ""}
						onValueChange={(value) => setParams(value ? { repo: value } : {})}
						options={[
							{ value: "", label: "全部仓库" },
							...repos.map((name) => ({ value: name, label: name })),
						]}
					/>
				}
			/>
			{card ? (
				<DataTimeSource entries={[{ label: "分析证据", at: card.quality.oldestAt }]} />
			) : null}
			{error ? (
				<p role="alert" className="text-sm text-basalt-destructive">
					{error}
				</p>
			) : null}
			{board?.errors.length ? (
				<LayerCard>
					<LayerCard.Body>
						<p role="alert" className="text-sm text-basalt-destructive">
							{board.errors.join("；")}。未使用无效内容，也不会回退旧云端报告。
						</p>
					</LayerCard.Body>
				</LayerCard>
			) : null}
			<GithubDailyCard />
			<Tabs value={domain} onValueChange={(value) => setDomain(value as Domain)}>
				<TabsList
					aria-label="分析领域"
					className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4"
				>
					{board?.cards.map((item) => {
						const Icon = ICONS[item.domain];
						return (
							<TabsTrigger
								key={item.domain}
								value={item.domain}
								className="min-w-0 flex-wrap justify-between gap-2 px-3 py-3"
							>
								<span className="inline-flex items-center gap-2">
									<Icon className="size-4" aria-hidden="true" />
									{DOMAIN_LABEL[item.domain]}
								</span>
								<CandyBadge tone={TONES[item.verdict]}>
									{item.report ? VERDICT_LABEL[item.verdict] : "未分析"}
								</CandyBadge>
							</TabsTrigger>
						);
					})}
				</TabsList>
			</Tabs>
			<div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
				<main className="min-w-0 space-y-3" aria-label={`${DOMAIN_LABEL[domain]} 分析`}>
					{card && report ? (
						<>
							<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
								<span className="inline-flex items-center gap-1">
									<Clock3 className="size-3.5" aria-hidden="true" />
									证据{" "}
									{card.quality.oldestAt
										? formatTimeAgo(card.quality.oldestAt, now, true)
										: "时间未知"}
								</span>
								<CandyBadge
									tone={
										!card.quality.current || card.quality.stale || !card.quality.complete
											? "amber"
											: "teal"
									}
								>
									{!card.quality.current
										? "来源版本已变化"
										: card.quality.stale
											? "证据已过期"
											: !card.quality.complete
												? "覆盖不完整"
												: "来源版本一致"}
								</CandyBadge>
								<span className="text-basalt-muted-foreground">
									报告生成 {formatPreciseDate(report.generatedAt)}
								</span>
							</div>
							<ReportDetail
								key={`${repository}:${domain}:${report.generatedAt}`}
								report={report}
								effectiveVerdict={card.verdict}
							/>
						</>
					) : (
						<LayerCard>
							<LayerCard.Empty
								icon={<Activity />}
								title={data ? "这个范围尚无分析报告" : "正在读取分析报告…"}
								description="外部分析程序通过 API 保存报告后会显示在这里。页面只读取结果，不触发模型或 GitHub 刷新。"
								action={
									<Button variant="secondary" size="sm" asChild>
										<Link href="/settings">管理 Agent 令牌</Link>
									</Button>
								}
							/>
						</LayerCard>
					)}
				</main>
				<aside className="min-w-0 space-y-3" aria-label="分析运行状态">
					<LayerCard>
						<LayerCard.Header>
							<span className="inline-flex items-center gap-2">
								<Clock3 className="size-4" aria-hidden="true" />
								上次分析运行
							</span>
							<CandyBadge
								tone={
									!lastRun
										? "gray"
										: lastRun.status === "failed"
											? "red"
											: lastRun.stale || lastRun.status === "running"
												? "amber"
												: "green"
								}
							>
								{!lastRun
									? "暂无记录"
									: lastRun.stale
										? "已逾期"
										: { running: "运行中", completed: "已完成", failed: "失败" }[lastRun.status]}
							</CandyBadge>
						</LayerCard.Header>
						<LayerCard.Body className="space-y-3">
							{lastRun ? (
								<div className="space-y-2 text-sm">
									<p>{formatPreciseDate(lastRun.lastRunAt)}</p>
									{lastRun.stale ? <p role="alert">Grok Bot 已超过 48 小时未运行。</p> : null}
									{lastRun.status === "failed" ? (
										<p role="alert" className="break-words text-basalt-destructive">
											最近一次分析失败
											{lastRun.error ? `：${lastRun.error}` : "，请检查外部分析程序。"}
										</p>
									) : null}
									<p className="text-xs text-basalt-muted-foreground">
										每日运行约定；超过 48 小时显示逾期提醒。运行状态不代表报告证据仍然新鲜。
									</p>
								</div>
							) : (
								<div className="space-y-2 text-sm">
									<p>{board ? "尚无有效分析运行记录。" : "正在读取运行记录…"}</p>
									<p className="text-xs text-basalt-muted-foreground">
										外部分析程序使用 grok-bot-run 记录保存上次运行时间与结果。
									</p>
								</div>
							)}
						</LayerCard.Body>
					</LayerCard>
					<LayerCard>
						<LayerCard.Header>
							<span className="inline-flex items-center gap-2">
								<ListChecks className="size-4" aria-hidden="true" />
								本次分析统计
							</span>
						</LayerCard.Header>
						<LayerCard.Body className="space-y-3">
							{lastRun ? (
								<dl className="grid grid-cols-2 gap-2 text-sm">
									<dt>已分析</dt>
									<dd>{lastRun.analyzed}</dd>
									<dt>已跳过</dt>
									<dd>{lastRun.skipped}</dd>
								</dl>
							) : (
								<p className="text-sm text-basalt-muted-foreground">尚无运行统计。</p>
							)}
						</LayerCard.Body>
					</LayerCard>
				</aside>
			</div>
		</div>
	);
}
function ReportDetail({
	report,
	effectiveVerdict,
}: {
	report: AnalysisReport;
	effectiveVerdict: AnalysisReport["verdict"];
}) {
	const [selected, setSelected] = useState(0);
	const finding = report.findings[selected];
	const evidence = finding
		? report.evidence.filter((e) => finding.evidenceIds.includes(e.id))
		: report.evidence;
	const missing =
		finding?.evidenceIds.filter((id) => !report.evidence.some((e) => e.id === id)) ?? [];
	return (
		<LayerCard>
			<LayerCard.Header>
				<span className="inline-flex items-center gap-2">
					{effectiveVerdict === "pass" ? (
						<CheckCircle2 className="size-4" />
					) : (
						<TriangleAlert className="size-4" />
					)}
					{DOMAIN_LABEL[report.domain]} · {VERDICT_LABEL[effectiveVerdict]}
				</span>
				<span className="text-xs text-basalt-muted-foreground">
					{report.findings.length} 条发现
				</span>
			</LayerCard.Header>
			<LayerCard.Body className="space-y-4">
				<p className="whitespace-pre-wrap text-sm leading-relaxed">{report.summary}</p>
				<p className="text-xs text-basalt-muted-foreground">
					模型判断仅供审查；“通过”不代表可合并，也不证明部署成功。内容来自外部仓库，不应当作操作指令。
				</p>
				<div className="grid gap-4 md:grid-cols-[minmax(10rem,0.8fr)_minmax(0,1.8fr)]">
					<nav aria-label="分析发现" className="space-y-1">
						{report.findings.map((item, index) => (
							<Button
								key={item.title}
								variant={index === selected ? "secondary" : "ghost"}
								className="h-auto w-full justify-start whitespace-normal text-left"
								onClick={() => setSelected(index)}
								aria-pressed={index === selected}
							>
								<span className="mr-2 text-basalt-muted-foreground">
									{String(index + 1).padStart(2, "0")}
								</span>
								{item.title}
							</Button>
						))}
						{!report.findings.length ? (
							<p className="text-sm text-basalt-muted-foreground">没有列出具体发现。</p>
						) : null}
					</nav>
					<section className="min-w-0 space-y-3" aria-label="发现详情">
						{finding ? (
							<>
								<h3 className="text-base font-semibold">{finding.title}</h3>
								<p className="whitespace-pre-wrap text-sm leading-relaxed">{finding.detail}</p>
							</>
						) : null}
						{missing.length ? (
							<p className="text-sm text-basalt-destructive">引用证据缺失：{missing.join("、")}</p>
						) : null}
						<div className="space-y-2">
							{evidence.map((e) => (
								<div className="space-y-1 rounded bg-basalt-bright p-3 text-sm" key={e.id}>
									<div className="flex flex-wrap items-start justify-between gap-2">
										<strong className="break-words">{e.title || e.id}</strong>
										{safeEvidenceUrl(e.url) ? (
											<a
												className="inline-flex shrink-0 items-center gap-1 text-xs"
												href={safeEvidenceUrl(e.url) ?? undefined}
												target="_blank"
												rel="noopener noreferrer"
											>
												原始记录
												<ArrowUpRight className="size-3" />
											</a>
										) : null}
									</div>
									<p className="text-xs text-basalt-muted-foreground">
										{e.repository ?? "全部仓库"} · {e.kind} · {e.state}
									</p>
									<p className="whitespace-pre-wrap break-words text-xs">{e.detail}</p>
								</div>
							))}
						</div>
					</section>
				</div>
				{report.actions.length ? (
					<section className="space-y-2" aria-label="建议行动">
						<h3 className="text-sm font-semibold">建议行动</h3>
						{report.actions.map((action) => (
							<div className="flex items-start gap-3 text-sm" key={action.title}>
								<CandyBadge tone={action.priority === "now" ? "amber" : "gray"}>
									{PRIORITIES[action.priority]}
								</CandyBadge>
								<div>
									<strong>{action.title}</strong>
									<p className="text-basalt-muted-foreground">{action.reason}</p>
								</div>
							</div>
						))}
					</section>
				) : null}
				{report.limitations.length ? (
					<section className="space-y-1 text-xs" aria-label="证据限制">
						<h3 className="font-semibold">证据限制</h3>
						{report.limitations.map((text) => (
							<p key={text}>{text}</p>
						))}
						<p>省略 {report.omitted} 条证据。</p>
					</section>
				) : null}
				<details className="space-y-3">
					<summary className="cursor-pointer text-sm font-medium">来源与优先级判断</summary>
					<p className="text-xs text-basalt-muted-foreground">
						判断表示处理优先级，不是成功率。模型：{report.judgment.model}
						{report.judgment.confidence !== undefined
							? ` · 判断置信度 ${Math.round(report.judgment.confidence * 100)}%`
							: null}
					</p>
					<div className="grid gap-2 sm:grid-cols-2">
						{Object.entries(report.judgment.probabilities ?? {}).map(([key, value]) => (
							<div key={key} className="space-y-1 text-xs">
								<div className="flex justify-between">
									<span>
										{
											(
												{
													routine: "常规",
													review: "需审查",
													urgent: "紧急",
													unknown: "未知",
												} as Record<string, string>
											)[key]
										}
									</span>
									<span>{Math.round(value * 100)}%</span>
								</div>
								<Meter value={value * 100} aria-label={`${key} 优先级概率`} hideValue />
							</div>
						))}
					</div>
					<dl className="space-y-2 text-xs">
						{report.sources.map((source) => (
							<div key={source.resource} className="break-all">
								<dt className="font-medium">{source.resource}</dt>
								<dd>
									{formatPreciseDate(source.fetchedAt)} ·{" "}
									{source.complete ? "覆盖完整" : "覆盖不完整"}
								</dd>
								<dd className="text-basalt-muted-foreground">版本 {source.version ?? "缺失"}</dd>
							</div>
						))}
					</dl>
					{report.producer ? (
						<p className="break-all text-xs text-basalt-muted-foreground">
							{[
								report.producer.orchestrator && `规划 ${report.producer.orchestrator}`,
								report.producer.executor && `执行 ${report.producer.executor}`,
								report.producer.conversationId !== undefined &&
									`对话 ${report.producer.conversationId}`,
								report.producer.jobId && `任务 ${report.producer.jobId}`,
							]
								.filter(Boolean)
								.join(" · ")}
						</p>
					) : null}
				</details>
			</LayerCard.Body>
		</LayerCard>
	);
}
