import { Button, Link } from "@nocoo/basalt";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@nocoo/basalt/components/accordion";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { JudgmentResult } from "../../lib/ai-review";
import type { RepoAssessment } from "../../lib/repo-assessment";
import { CandyBadge } from "../components/layout/candy-badge";
import { DetailSkeleton } from "../components/layout/page-skeleton";
import { reportError } from "../lib/error-ui";
import { type CandyTone, formatDate } from "../lib/format";
import {
	assessmentPending,
	assessmentStale,
	loadRepoAssessment,
	prioritizedActions,
} from "../viewmodels/repo-assessment";

type Report = NonNullable<RepoAssessment["report"]>;

const REPORT_STATUS: Record<Report["overall"], { label: string; tone: CandyTone }> = {
	healthy: { label: "正常", tone: "green" },
	attention: { label: "需要关注", tone: "amber" },
	urgent: { label: "优先处理", tone: "red" },
	unknown: { label: "信息不足", tone: "gray" },
};
const JUDGMENT_STATUS = {
	urgent: { label: "立即处理", tone: "red" },
	review: { label: "人工判断", tone: "amber" },
	routine: { label: "常规跟进", tone: "green" },
	unknown: { label: "信息不足", tone: "gray" },
} as const;
const ACTION_PRIORITY = {
	now: { label: "立即", tone: "red" },
	next: { label: "接下来", tone: "amber" },
	later: { label: "后续", tone: "blue" },
} as const;
const DELIVERY_TREND = {
	accelerating: "交付加快",
	steady: "节奏稳定",
	slowing: "交付放缓",
	inactive: "近期无交付",
	unknown: "节奏待确认",
} as const;
const RUN_STATUS: Record<RepoAssessment["status"], string> = {
	unconfigured: "未配置 AI",
	missing: "尚未生成",
	judgment: "Jev 正在判断",
	summary: "正在生成报告",
	complete: "评估完成",
	failed: "本次评估失败",
};
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

function EvidenceReferences({ ids }: { ids: string[] }) {
	if (ids.length === 0) return null;
	return (
		<Accordion type="single" collapsible>
			<AccordionItem value="evidence" className="border-0">
				<AccordionTrigger className="py-2 text-xs text-basalt-muted-foreground">
					参考记录（{ids.length}）
				</AccordionTrigger>
				<AccordionContent className="pb-0">
					<p className="break-all font-mono text-xs text-basalt-muted-foreground">
						{ids.join(" · ")}
					</p>
				</AccordionContent>
			</AccordionItem>
		</Accordion>
	);
}

function ReportSection({
	title,
	section,
	trend,
}: {
	title: string;
	section: Report["security"];
	trend?: Report["delivery"]["trend"];
}) {
	const status = REPORT_STATUS[section.status];
	return (
		<LayerCard className="min-w-0">
			<LayerCard.Header className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium">{title}</h3>
				<CandyBadge tone={status.tone}>{status.label}</CandyBadge>
			</LayerCard.Header>
			<LayerCard.Body className="space-y-2">
				{trend ? (
					<p className="text-xs text-basalt-muted-foreground">{DELIVERY_TREND[trend]}</p>
				) : null}
				<p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">
					{section.summary}
				</p>
				<EvidenceReferences ids={section.evidenceIds} />
			</LayerCard.Body>
		</LayerCard>
	);
}

function JudgmentDetails({ result }: { result: JudgmentResult }) {
	return (
		<LayerCard className="min-w-0">
			<LayerCard.Header className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium">Jev 判断</h3>
				<span className="text-xs text-basalt-muted-foreground">
					{result.judgments.length} 项 · {result.model} · 模板 v{result.templateVersion}
				</span>
			</LayerCard.Header>
			<LayerCard.Body>
				<Accordion type="multiple">
					{result.judgments.map((judgment) => {
						const status = JUDGMENT_STATUS[judgment.choice];
						return (
							<AccordionItem key={judgment.id} value={judgment.id}>
								<AccordionTrigger className="gap-3 py-3 text-sm">
									<span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
										<span className="min-w-0 text-left [overflow-wrap:anywhere]">
											{judgment.question}
										</span>
										<span className="flex flex-wrap items-center gap-2">
											<CandyBadge tone={status.tone}>{status.label}</CandyBadge>
											<span className="text-xs tabular-nums text-basalt-muted-foreground">
												置信度 {percent.format(judgment.confidence)}
											</span>
											{judgment.uncertain ? (
												<span className="text-xs text-basalt-muted-foreground">需人工复核</span>
											) : null}
										</span>
									</span>
								</AccordionTrigger>
								<AccordionContent className="space-y-2">
									<dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
										{Object.entries(judgment.probabilities).map(([choice, probability]) => (
											<div key={choice}>
												<dt className="text-basalt-muted-foreground">
													{JUDGMENT_STATUS[choice as keyof typeof JUDGMENT_STATUS].label}
												</dt>
												<dd className="mt-1 tabular-nums">
													{percent.format(probability)}（{probability}）
												</dd>
											</div>
										))}
									</dl>
									<EvidenceReferences ids={judgment.evidenceIds} />
								</AccordionContent>
							</AccordionItem>
						);
					})}
				</Accordion>
			</LayerCard.Body>
		</LayerCard>
	);
}

export function RepoAssessmentPanel({ owner, name }: { owner: string; name: string }) {
	const [assessment, setAssessment] = useState<RepoAssessment | { missing: true } | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the read after a failure.
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		setFailed(false);
		async function load() {
			try {
				const next = await loadRepoAssessment(owner, name);
				if (cancelled) return;
				setAssessment(next);
				if (!("missing" in next) && assessmentPending(next.status)) {
					timer = setTimeout(() => void load(), 3000);
				}
			} catch (error) {
				if (cancelled) return;
				reportError(error);
				setFailed(true);
			}
		}
		void load();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [owner, name, attempt]);

	const saved = assessment && !("missing" in assessment) ? assessment : null;
	const report = saved?.report;
	const stale = saved ? assessmentStale(saved) : false;
	const status = saved?.status ?? "missing";

	return (
		<div className="space-y-4" data-testid="repo-assessment">
			{failed ? (
				<LayerCard>
					<LayerCard.Body className="flex flex-wrap items-center justify-between gap-3">
						<p role="alert" className="text-sm">
							暂时无法读取 AI 评估，请重试。
						</p>
						<Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
							重新读取
						</Button>
					</LayerCard.Body>
				</LayerCard>
			) : null}
			{!assessment && !failed ? <DetailSkeleton label="加载 AI 评估" /> : null}
			{assessment ? (
				<LayerCard>
					<LayerCard.Header className="flex flex-wrap items-center justify-between gap-2">
						<h2 className="flex items-center gap-2 font-medium">
							<Sparkles className="size-4" aria-hidden="true" />
							仓库评估
						</h2>
						<span className="flex flex-wrap items-center gap-2">
							{report ? (
								<CandyBadge tone={REPORT_STATUS[report.overall].tone}>
									{REPORT_STATUS[report.overall].label}
								</CandyBadge>
							) : null}
							{stale ? <CandyBadge tone="gray">历史报告</CandyBadge> : null}
							<span role="status" className="text-xs text-basalt-muted-foreground">
								{RUN_STATUS[status]}
							</span>
						</span>
					</LayerCard.Header>
					<LayerCard.Body className="space-y-3">
						{saved?.sourceAt || saved?.reportAt ? (
							<div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-basalt-muted-foreground">
								<span>
									最新数据{" "}
									<time dateTime={saved.sourceAt ?? undefined}>{formatDate(saved.sourceAt)}</time>
								</span>
								<span>
									报告生成{" "}
									<time dateTime={saved.reportAt ?? undefined}>{formatDate(saved.reportAt)}</time>
								</span>
							</div>
						) : null}
						{stale ? (
							<p role="note" className="text-sm text-basalt-muted-foreground">
								报告未随本次数据更新完成，以下保留上次成功结果。
							</p>
						) : null}
						{status === "unconfigured" ? (
							<p className="text-sm text-basalt-muted-foreground">
								请先在
								<Link href="/settings" className="mx-1">
									设置
								</Link>
								中配置总结模型和 Jev API key。
							</p>
						) : status === "missing" ? (
							<p className="text-sm text-basalt-muted-foreground">
								尚未生成评估，将在该仓库下一次成功刷新数据后自动生成。
							</p>
						) : status === "failed" ? (
							<p className="text-sm text-basalt-muted-foreground">
								请
								<Link href="/settings" className="mx-1">
									检查 AI 设置
								</Link>
								，下次成功刷新数据时会再次评估。
								{saved?.error ? (
									<span className="ml-1">
										诊断：<code>{saved.error}</code>
									</span>
								) : null}
							</p>
						) : null}
						{report ? (
							<p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">
								{report.summary}
							</p>
						) : null}
					</LayerCard.Body>
				</LayerCard>
			) : null}
			{report ? (
				<>
					<div className="grid gap-4 md:grid-cols-2">
						<ReportSection title="安全" section={report.security} />
						<ReportSection title="Pull Requests" section={report.pullRequests} />
						<ReportSection title="Issues" section={report.issues} />
						<ReportSection
							title="交付节奏"
							section={report.delivery}
							trend={report.delivery.trend}
						/>
					</div>
					<LayerCard>
						<LayerCard.Header>
							<h3 className="font-medium">建议行动</h3>
						</LayerCard.Header>
						<LayerCard.Body>
							{report.actions.length > 0 ? (
								<ol className="space-y-4">
									{prioritizedActions(report.actions).map((action, index) => (
										<li key={`${action.priority}-${index.toString()}`} className="space-y-2">
											<div className="flex flex-wrap items-start gap-2">
												<CandyBadge tone={ACTION_PRIORITY[action.priority].tone}>
													{ACTION_PRIORITY[action.priority].label}
												</CandyBadge>
												<h4 className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
													{action.title}
												</h4>
											</div>
											<p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">
												{action.reason}
											</p>
											<EvidenceReferences ids={action.evidenceIds} />
										</li>
									))}
								</ol>
							) : (
								<p className="text-sm text-basalt-muted-foreground">暂无建议行动。</p>
							)}
						</LayerCard.Body>
					</LayerCard>
					{report.limitations.length > 0 ? (
						<LayerCard>
							<LayerCard.Header>
								<h3 className="font-medium">评估范围与限制</h3>
							</LayerCard.Header>
							<LayerCard.Body>
								<ul className="list-disc space-y-2 pl-4 text-sm text-basalt-muted-foreground">
									{report.limitations.map((limitation, index) => (
										<li
											key={index.toString()}
											className="whitespace-pre-line [overflow-wrap:anywhere]"
										>
											{limitation}
										</li>
									))}
								</ul>
							</LayerCard.Body>
						</LayerCard>
					) : null}
				</>
			) : null}
			{saved?.judgment ? <JudgmentDetails result={saved.judgment} /> : null}
		</div>
	);
}
