import { Button, Link, Tabs, TabsList, TabsTrigger } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Meter } from "@nocoo/basalt/components/meter";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import type { AnalysisReport, Domain } from "@nocoo/giraffe-agent/contracts";
import {
	Activity,
	ArrowUpRight,
	CheckCircle2,
	Clock3,
	GitPullRequest,
	Layers3,
	ListChecks,
	Play,
	Radio,
	RefreshCw,
	TriangleAlert,
	Workflow,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
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
	requestAnalysis,
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
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
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
	const online = board?.runners.filter((r) => r.online).length ?? 0;
	async function enqueue() {
		if (!data) return;
		setBusy(true);
		setError("");
		try {
			await requestAnalysis(data.account_id, repository, [domain]);
			setMessage("分析请求已加入队列，由本地 Agent 执行。");
			setData(await loadAnalysis());
		} catch {
			setError("请求未保存，请检查账号状态后重试。");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="space-y-4" data-testid="analysis-desk">
			<PageHeader
				title="分析台"
				description="本地 Agent 的判断与依据，和 GitHub 原始事实分开查看"
				actions={
					<>
						<SelectField
							label="分析范围"
							value={repository ?? ""}
							onValueChange={(value) => setParams(value ? { repo: value } : {})}
							options={[
								{ value: "", label: "全部仓库" },
								...repos.map((name) => ({ value: name, label: name })),
							]}
						/>
						<Button size="sm" disabled={busy || !data} onClick={() => void enqueue()}>
							<Play className="size-4" aria-hidden="true" />
							{busy ? "正在提交…" : "请求分析"}
						</Button>
					</>
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
			{message ? (
				<p role="status" className="text-sm">
					{message}
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
								description="先在本机运行 giraffe login，再运行 giraffe watch。这里读取 Agent 保存的报告；请求分析不会在云端调用模型。"
								action={
									<Button variant="secondary" size="sm" asChild>
										<Link href="/settings">管理 Agent 令牌</Link>
									</Button>
								}
							/>
						</LayerCard>
					)}
				</main>
				<aside className="min-w-0 space-y-3" aria-label="执行器与任务">
					<LayerCard>
						<LayerCard.Header>
							<span className="inline-flex items-center gap-2">
								<Radio className="size-4" aria-hidden="true" />
								本地执行器
							</span>
							<CandyBadge tone={online ? "green" : "gray"}>
								{online ? `${online} 在线` : "离线"}
							</CandyBadge>
						</LayerCard.Header>
						<LayerCard.Body className="space-y-3">
							{board?.runners.length ? (
								board.runners.map((r) => (
									<div className="space-y-1 text-xs" key={r.runnerId}>
										<p className="break-all font-medium">{r.runnerId}</p>
										<p>
											{r.online
												? r.state === "working"
													? "正在分析"
													: "等待任务"
												: "超过 90 秒无心跳 / 已停止"}
										</p>
										<p className="text-basalt-muted-foreground">
											{formatPreciseDate(r.lastSeenAt)}
										</p>
										<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-basalt-muted-foreground">
											<dt>规划</dt>
											<dd className="break-all">{r.models.orchestrator}</dd>
											<dt>判断</dt>
											<dd className="break-all">{r.models.decision}</dd>
											<dt>执行</dt>
											<dd className="break-all">{r.models.executor}</dd>
										</dl>
									</div>
								))
							) : (
								<div className="space-y-2 text-sm">
									<p>没有检测到本地 Agent。</p>
									<code className="block rounded bg-basalt-control p-2 text-xs">
										giraffe login
										<br />
										giraffe watch
									</code>
									<p className="text-xs text-basalt-muted-foreground">
										离线时请求保留在队列，Agent 上线后处理。
									</p>
								</div>
							)}
						</LayerCard.Body>
					</LayerCard>
					<LayerCard>
						<LayerCard.Header>
							<span className="inline-flex items-center gap-2">
								<RefreshCw className="size-4" aria-hidden="true" />
								任务队列
							</span>
							<span className="text-xs text-basalt-muted-foreground">
								{board?.jobs.length ?? 0}
							</span>
						</LayerCard.Header>
						<LayerCard.Body className="space-y-3">
							{board?.jobs.slice(0, 12).map((job) => (
								<div className="space-y-1 text-xs" key={job.id}>
									<div className="flex justify-between gap-2">
										<strong className="truncate">{job.repository ?? "全部仓库"}</strong>
										<span>
											{(
												{
													pending: "等待执行",
													running: "执行中",
													completed: "已完成",
													failed: "失败",
													cancelled: "已取消",
												} as Record<string, string>
											)[job.status] ?? job.status}
										</span>
									</div>
									<p className="break-all text-basalt-muted-foreground">{job.id}</p>
									<p>{typeof job.payload.progress === "string" ? job.payload.progress : ""}</p>
									{job.status === "failed" ? (
										<p className="text-basalt-destructive">
											执行失败；检查本地 Agent 日志后可重新请求。
										</p>
									) : null}
								</div>
							)) ?? null}
							{!board?.jobs.length ? (
								<p className="text-sm text-basalt-muted-foreground">
									暂无任务。选择领域后请求分析。
								</p>
							) : null}
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
					<summary className="cursor-pointer text-sm font-medium">来源与 Jev 判断</summary>
					<p className="text-xs text-basalt-muted-foreground">
						Jev 表示处理优先级，不是成功率。模型：{report.judgment.model} · 判断置信度{" "}
						{Math.round(report.judgment.confidence * 100)}%
					</p>
					<div className="grid gap-2 sm:grid-cols-2">
						{Object.entries(report.judgment.probabilities).map(([key, value]) => (
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
					<p className="break-all text-xs text-basalt-muted-foreground">
						规划 {report.producer.orchestrator} · 执行 {report.producer.executor} · 对话{" "}
						{report.producer.conversationId} · 任务 {report.producer.jobId}
					</p>
				</details>
			</LayerCard.Body>
		</LayerCard>
	);
}
