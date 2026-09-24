import { Button, Link } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import {
	Activity,
	ArrowRight,
	CircleAlert,
	CircleCheck,
	CircleDot,
	CircleHelp,
	ClipboardCheck,
	Clock3,
	FileCheck2,
	FileClock,
	GitPullRequest,
	History,
	Info,
	KeyRound,
	type LucideIcon,
	RefreshCw,
	ShieldAlert,
	Sparkles,
	UserRoundCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { RepoAssessment } from "../../lib/repo-assessment";
import { CandyBadge } from "../components/layout/candy-badge";
import { IconLabel } from "../components/layout/icon-label";
import { DetailSkeleton } from "../components/layout/page-skeleton";
import { reportError } from "../lib/error-ui";
import { formatDate } from "../lib/format";
import {
	ACTION_PRIORITY,
	DELIVERY_TREND,
	REPORT_STATUS,
	RUN_STATUS,
} from "../viewmodels/assessment-presentation";
import { describeRunIssue } from "../viewmodels/factory-runs";
import {
	assessmentPending,
	assessmentStale,
	loadRepoAssessment,
	prioritizedActions,
} from "../viewmodels/repo-assessment";
import { EvidenceReferences, JudgmentDetails } from "./assessment-judgments";

type Report = NonNullable<RepoAssessment["report"]>;

const REPORT_ICONS = {
	healthy: CircleCheck,
	attention: UserRoundCheck,
	urgent: ShieldAlert,
	unknown: CircleHelp,
};
const RUN_ICONS = {
	unconfigured: KeyRound,
	missing: FileClock,
	judgment: Sparkles,
	summary: RefreshCw,
	complete: FileCheck2,
	failed: CircleAlert,
};
const ACTION_ICONS = { now: ShieldAlert, next: ArrowRight, later: Clock3 };

function ReportSection({
	title,
	icon,
	section,
	trend,
}: {
	title: string;
	icon: LucideIcon;
	section: Report["security"];
	trend?: Report["delivery"]["trend"];
}) {
	const status = REPORT_STATUS[section.status];
	return (
		<LayerCard className="min-w-0">
			<LayerCard.Header className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium text-basalt-foreground">
					<IconLabel icon={icon}>{title}</IconLabel>
				</h3>
				<CandyBadge tone={status.tone} icon={REPORT_ICONS[section.status]}>
					{status.label}
				</CandyBadge>
			</LayerCard.Header>
			<LayerCard.Body className="space-y-2">
				{trend ? (
					<p className="text-xs text-basalt-muted-foreground">
						<IconLabel icon={Activity}>{DELIVERY_TREND[trend]}</IconLabel>
					</p>
				) : null}
				<p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">
					{section.summary}
				</p>
				<EvidenceReferences ids={section.evidenceIds} />
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
	const issue = describeRunIssue(saved?.error ?? "ai_error", "assessment");

	return (
		<div className="space-y-4" data-testid="repo-assessment">
			{failed ? (
				<LayerCard>
					<LayerCard.Body className="flex flex-wrap items-center justify-between gap-3">
						<p role="alert" className="text-sm">
							暂时无法读取 AI 评估，请重试。
						</p>
						<Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
							<RefreshCw className="size-4" strokeWidth={1.5} aria-hidden="true" />
							重新读取
						</Button>
					</LayerCard.Body>
				</LayerCard>
			) : null}
			{!assessment && !failed ? <DetailSkeleton label="加载 AI 评估" /> : null}
			{assessment ? (
				<LayerCard>
					<LayerCard.Header className="flex flex-wrap items-center justify-between gap-2">
						<h2 className="font-medium text-basalt-foreground">
							<IconLabel icon={Sparkles}>仓库评估</IconLabel>
						</h2>
						<span className="flex flex-wrap items-center gap-2">
							{report ? (
								<CandyBadge
									tone={REPORT_STATUS[report.overall].tone}
									icon={REPORT_ICONS[report.overall]}
								>
									{REPORT_STATUS[report.overall].label}
								</CandyBadge>
							) : null}
							{stale ? (
								<CandyBadge tone="gray" icon={History}>
									历史报告
								</CandyBadge>
							) : null}
							<span role="status" className="text-xs text-basalt-muted-foreground">
								<IconLabel icon={RUN_ICONS[status]}>{RUN_STATUS[status]}</IconLabel>
							</span>
						</span>
					</LayerCard.Header>
					<LayerCard.Body className="space-y-3">
						{saved?.sourceAt || saved?.reportAt ? (
							<div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-basalt-muted-foreground">
								<span className="inline-flex flex-wrap items-center gap-1.5">
									<Clock3 className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
									最新数据{" "}
									<time dateTime={saved.sourceAt ?? undefined}>{formatDate(saved.sourceAt)}</time>
								</span>
								<span className="inline-flex flex-wrap items-center gap-1.5">
									<FileCheck2 className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
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
								{issue.reason} {issue.action}
								{issue.settings ? (
									<Link href="/settings" className="mx-1">
										检查 AI 设置
									</Link>
								) : null}
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
						<ReportSection title="安全" icon={ShieldAlert} section={report.security} />
						<ReportSection
							title="Pull Requests"
							icon={GitPullRequest}
							section={report.pullRequests}
						/>
						<ReportSection title="Issues" icon={CircleDot} section={report.issues} />
						<ReportSection
							title="交付节奏"
							icon={Activity}
							section={report.delivery}
							trend={report.delivery.trend}
						/>
					</div>
					<LayerCard>
						<LayerCard.Header>
							<h3 className="font-medium text-basalt-foreground">
								<IconLabel icon={ClipboardCheck}>建议行动</IconLabel>
							</h3>
						</LayerCard.Header>
						<LayerCard.Body>
							{report.actions.length > 0 ? (
								<ol className="space-y-4">
									{prioritizedActions(report.actions).map((action, index) => (
										<li
											key={`${action.priority}-${index.toString()}`}
											className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3"
										>
											<CandyBadge
												tone={ACTION_PRIORITY[action.priority].tone}
												icon={ACTION_ICONS[action.priority]}
												className="justify-center"
											>
												{ACTION_PRIORITY[action.priority].label}
											</CandyBadge>
											<div className="min-w-0 space-y-1">
												<h4 className="text-sm font-medium leading-6 [overflow-wrap:anywhere]">
													{action.title}
												</h4>
												<p className="whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]">
													{action.reason}
												</p>
												<EvidenceReferences ids={action.evidenceIds} />
											</div>
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
								<h3 className="font-medium text-basalt-foreground">
									<IconLabel icon={Info}>评估范围与限制</IconLabel>
								</h3>
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
