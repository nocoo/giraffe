import { Link } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import {
	Activity,
	BrainCircuit,
	CircleDot,
	GitPullRequest,
	Lightbulb,
	type LucideIcon,
	ShieldAlert,
	Target,
	Workflow,
} from "lucide-react";
import { CandyBadge } from "../components/layout/candy-badge";
import { IconLabel } from "../components/layout/icon-label";
import { ProjectLabel } from "../components/layout/project-identity";
import { formatCount } from "../lib/format";
import { REPORT_STATUS } from "../viewmodels/assessment-presentation";
import {
	type aiCoverage,
	type Finding,
	FOCUS_CATEGORY,
	type FocusCategory,
	type FocusRepo,
} from "../viewmodels/focus";
import { pushAge } from "../viewmodels/insights";

const CATEGORY_ICON: Record<FocusCategory, LucideIcon> = {
	security: ShieldAlert,
	delivery: Workflow,
	review: GitPullRequest,
	issues: CircleDot,
	ai: BrainCircuit,
	activity: Activity,
};
const LEVEL = {
	urgent: { label: "优先处理", tone: "red" },
	attention: { label: "需要关注", tone: "amber" },
	watch: { label: "持续观察", tone: "blue" },
} as const;
const REASONS_SHOWN = 3;

export function FocusSection({
	ranked,
	findings,
	coverage,
}: {
	ranked: FocusRepo[];
	findings: Finding[];
	coverage: ReturnType<typeof aiCoverage>;
}) {
	const source = coverage.configured
		? `结合 ${coverage.current} 份当前 AI 报告${coverage.stale ? `、${coverage.stale} 份旧版报告` : ""}、Jev 判断、CI、安全告警与待办计算`
		: "未配置 AI，仅按 CI、安全告警与待办规则计算";
	return (
		<SectionRule
			title={<IconLabel icon={Target}>最值得关注的仓库</IconLabel>}
			hint="每条原因带权重：AI 总评与立即行动、Jev 紧急判断、默认分支持续失败、高危告警权重最高；旧版本报告按 60% 计入。分数只用于排序。"
			actions={<span className="text-xs text-basalt-muted-foreground">{source}</span>}
		>
			<div className="giraffe-focus" data-testid="insight-focus">
				{ranked.length ? (
					<ol className="giraffe-focus-list" aria-label="Top 10 关注仓库">
						{ranked.map((item, i) => (
							<FocusItem key={item.repo} item={item} rank={i + 1} />
						))}
					</ol>
				) : (
					<LayerCard>
						<LayerCard.Well>
							<LayerCard.Empty
								icon={<Target />}
								title="暂无需要特别关注的仓库"
								description="参与统计的仓库没有触发任何关注规则。"
							/>
						</LayerCard.Well>
					</LayerCard>
				)}
				<LayerCard className="giraffe-findings" padding="md">
					<h3 className="text-sm font-semibold">
						<IconLabel icon={Lightbulb}>跨仓发现</IconLabel>
					</h3>
					{findings.length ? (
						<ul aria-label="跨仓发现">
							{findings.map((f) => (
								<li key={f.text} data-tone={f.tone}>
									{f.text}
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-basalt-muted-foreground">没有值得单独指出的跨仓模式。</p>
					)}
				</LayerCard>
			</div>
		</SectionRule>
	);
}

function FocusItem({ item, rank }: { item: FocusRepo; rank: number }) {
	const Icon = CATEGORY_ICON[item.primary];
	const shown = item.reasons.slice(0, REASONS_SHOWN);
	const hidden = item.reasons.length - shown.length;
	const ai = item.ai?.overall ? REPORT_STATUS[item.ai.overall] : null;
	return (
		<li className="giraffe-focus-item" data-level={item.level}>
			<span className="giraffe-focus-rank" aria-hidden="true">
				{rank}
			</span>
			<div className="min-w-0">
				<div className="giraffe-focus-head">
					<Link
						href={`/repos/${item.repo}`}
						className="min-w-0 font-medium text-basalt-foreground hover:text-basalt-primary"
					>
						<ProjectLabel repo={item.repo} />
					</Link>
					<CandyBadge tone={LEVEL[item.level].tone}>{LEVEL[item.level].label}</CandyBadge>
				</div>
				<ul className="giraffe-focus-reasons" aria-label={`${item.repo} 关注原因`}>
					{shown.map((r) => {
						const ReasonIcon = CATEGORY_ICON[r.category];
						return (
							<li
								key={r.text}
								title={`${FOCUS_CATEGORY[r.category]} · 权重 ${Math.round(r.weight)}`}
							>
								<ReasonIcon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.5} />
								<span>{r.text}</span>
							</li>
						);
					})}
				</ul>
				{hidden > 0 ? (
					<p
						className="giraffe-focus-more"
						title={item.reasons
							.slice(REASONS_SHOWN)
							.map((r) => r.text)
							.join("\n")}
					>
						另有 {hidden} 条原因
					</p>
				) : null}
			</div>
			<dl className="giraffe-focus-meta">
				<div>
					<dt>主要方面</dt>
					<dd>
						<Icon aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
						{FOCUS_CATEGORY[item.primary]}
					</dd>
				</div>
				<div>
					<dt>AI 总评</dt>
					<dd>
						{ai ? (
							<CandyBadge tone={ai.tone}>
								{ai.label}
								{item.ai?.current ? "" : " · 旧版"}
							</CandyBadge>
						) : (
							<span className="text-basalt-muted-foreground">
								{item.ai?.status === "failed" ? "失败" : "—"}
							</span>
						)}
					</dd>
				</div>
				<div>
					<dt>待办</dt>
					<dd className="tabular-nums">
						{formatCount(item.issues)} / {formatCount(item.pulls)}
					</dd>
				</div>
				<div>
					<dt>推送</dt>
					<dd className="tabular-nums">{pushAge(item.days)}</dd>
				</div>
			</dl>
		</li>
	);
}
