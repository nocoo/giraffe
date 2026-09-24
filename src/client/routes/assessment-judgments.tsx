import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@nocoo/basalt/components/accordion";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Meter } from "@nocoo/basalt/components/meter";
import {
	Activity,
	BrainCircuit,
	CalendarDays,
	ChevronDown,
	CircleCheck,
	CircleDot,
	CircleHelp,
	Files,
	GitPullRequest,
	ShieldAlert,
	UserRoundCheck,
} from "lucide-react";
import type { Judgment, JudgmentResult } from "../../lib/ai-review";
import { CandyBadge } from "../components/layout/candy-badge";
import { IconLabel } from "../components/layout/icon-label";
import { candyClass } from "../lib/format";
import {
	JUDGMENT_STATUS,
	judgmentDistribution,
	judgmentHeading,
	judgmentOverview,
	percent,
} from "../viewmodels/assessment-presentation";

export const JUDGMENT_ICONS = {
	urgent: ShieldAlert,
	review: UserRoundCheck,
	routine: CircleCheck,
	unknown: CircleHelp,
};
const CATEGORY_ICONS = {
	security: ShieldAlert,
	prs: GitPullRequest,
	issues: CircleDot,
	delivery: Activity,
	general: BrainCircuit,
};

export function EvidenceReferences({ ids }: { ids: string[] }) {
	if (ids.length === 0) return null;
	return (
		<Accordion type="single" collapsible>
			<AccordionItem value="evidence" className="border-0">
				<AccordionTrigger className="group/evidence gap-2 py-2 text-xs text-basalt-muted-foreground">
					<IconLabel icon={Files}>参考记录（{ids.length}）</IconLabel>
					<ChevronDown
						className="size-3.5 shrink-0 group-aria-expanded/evidence:rotate-180"
						strokeWidth={1.5}
						aria-hidden="true"
					/>
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

function ProbabilityDistribution({ judgment, title }: { judgment: Judgment; title: string }) {
	const distribution = judgmentDistribution(judgment);
	return (
		<figure aria-label={`${title}概率分布`} className="space-y-3">
			<figcaption className="text-xs text-basalt-muted-foreground">四种判断的概率分布</figcaption>
			<div className="flex h-2 overflow-hidden rounded-full bg-basalt-muted" aria-hidden="true">
				{distribution.map((item) => (
					<span
						key={item.choice}
						className={candyClass(item.tone)}
						style={{ width: `${item.value}%` }}
						data-probability={item.value}
					/>
				))}
			</div>
			<dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
				{distribution.map((item) => (
					<div key={item.choice} className="flex items-center justify-between gap-2">
						<dt className="flex items-center gap-1.5 text-basalt-muted-foreground">
							<span
								className={`size-2 shrink-0 rounded-sm ${candyClass(item.tone)}`}
								aria-hidden="true"
							/>
							{JUDGMENT_STATUS[item.choice].label}
						</dt>
						<dd
							className={`tabular-nums ${item.choice === judgment.choice ? "font-semibold" : ""}`}
						>
							{item.label}
						</dd>
					</div>
				))}
			</dl>
		</figure>
	);
}

export function JudgmentDetails({ result }: { result: JudgmentResult }) {
	const counts = judgmentOverview(result.judgments);
	return (
		<LayerCard className="min-w-0">
			<LayerCard.Header className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="font-medium text-basalt-foreground">
					<IconLabel icon={BrainCircuit}>Jev 判断</IconLabel>
				</h3>
				<span className="text-xs text-basalt-muted-foreground">
					{result.judgments.length} 项 · {result.model} · 模板 v{result.templateVersion}
				</span>
			</LayerCard.Header>
			<LayerCard.Body className="space-y-3">
				{result.templateVersion === 2 ? (
					<div className="space-y-1 text-xs text-basalt-muted-foreground">
						<IconLabel icon={CalendarDays}>
							最近 14 天 · {result.focusWindow.since.slice(0, 10)} —{" "}
							{result.focusWindow.until.slice(0, 10)}（UTC）
						</IconLabel>
						<p>
							兼顾更早但仍活跃的 Issues 与 PR；安全风险以 Issues 为主要线索，GitHub
							安全告警作为补充。
						</p>
					</div>
				) : null}
				<fieldset
					className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs"
					aria-label="判断概况"
				>
					{Object.entries(JUDGMENT_STATUS).map(([choice, status]) => (
						<span key={choice} className="inline-flex items-center gap-2">
							<CandyBadge tone={status.tone} icon={JUDGMENT_ICONS[choice as Judgment["choice"]]}>
								{status.label}
							</CandyBadge>
							<strong className="tabular-nums">{counts[choice as Judgment["choice"]]}</strong>
						</span>
					))}
				</fieldset>
				<p className="text-xs leading-relaxed text-basalt-muted-foreground">
					按判断问题计数；{counts.uncertain}{" "}
					项需人工复核。置信度表示模型在选项中的概率集中程度，不代表结论正确率。
				</p>
				<Accordion type="multiple">
					{result.judgments.map((judgment) => {
						const status = JUDGMENT_STATUS[judgment.choice];
						const heading = judgmentHeading(judgment);
						return (
							<AccordionItem
								key={judgment.id}
								value={judgment.id}
								data-testid="assessment-judgment-row"
							>
								<AccordionTrigger className="group/judgment gap-3 py-3 text-sm hover:no-underline">
									<span className="assessment-judgment-summary">
										<IconLabel
											icon={CATEGORY_ICONS[heading.category]}
											className="assessment-judgment-title text-left font-medium"
										>
											{heading.title}
										</IconLabel>
										<CandyBadge
											data-testid="judgment-status"
											tone={status.tone}
											icon={JUDGMENT_ICONS[judgment.choice]}
											className="justify-center"
										>
											{status.label}
										</CandyBadge>
										<span
											data-testid="judgment-confidence"
											className="space-y-1 text-xs font-normal text-basalt-muted-foreground"
										>
											<span className="flex items-center justify-between gap-2">
												<span>置信度</span>
												<span className="tabular-nums text-basalt-foreground">
													{percent.format(judgment.confidence)}
												</span>
											</span>
											<Meter
												value={judgment.confidence * 100}
												aria-label={`${heading.title}置信度`}
												hideValue
											/>
										</span>
										<span className="assessment-review-flag text-xs font-normal text-basalt-muted-foreground">
											{judgment.uncertain ? (
												<IconLabel icon={UserRoundCheck}>需人工复核</IconLabel>
											) : null}
										</span>
									</span>
									<ChevronDown
										className="size-4 shrink-0 text-basalt-muted-foreground group-aria-expanded/judgment:rotate-180"
										strokeWidth={1.5}
										aria-hidden="true"
									/>
								</AccordionTrigger>
								<AccordionContent className="space-y-3 pb-4">
									<ProbabilityDistribution judgment={judgment} title={heading.title} />
									<p className="text-xs leading-relaxed text-basalt-muted-foreground [overflow-wrap:anywhere]">
										<span className="font-medium">原始判断问题：</span>
										{judgment.question}
									</p>
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
