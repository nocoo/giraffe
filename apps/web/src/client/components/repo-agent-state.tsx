import { Button } from "@nocoo/basalt";
import { DescriptionList } from "@nocoo/basalt/components/description-list";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { useEffect, useState } from "react";
import type { AgentStateStatus, RepoAgentState } from "../../lib/repo-agent-state";
import { formatDate } from "../lib/format";
import { agentStatePresentation, loadRepoAgentState } from "../viewmodels/repo-agent-state";
import { CandyBadge } from "./layout/candy-badge";

export function AgentStateBadge({ status }: { status: AgentStateStatus | null | undefined }) {
	if (!status) return null;
	const presentation = agentStatePresentation({ status });
	return (
		<CandyBadge tone={presentation.tone} aria-label={`管家状态：${status}`}>
			管家 · {presentation.label}
		</CandyBadge>
	);
}

export function RepoAgentStateCard({ owner, name }: { owner: string; name: string }) {
	const [attempt, setAttempt] = useState(0);
	return (
		<RepoAgentStateRead
			key={`${owner}/${name}/${attempt}`}
			owner={owner}
			name={name}
			retry={() => setAttempt((value) => value + 1)}
		/>
	);
}

function RepoAgentStateRead({
	owner,
	name,
	retry,
}: {
	owner: string;
	name: string;
	retry: () => void;
}) {
	const [state, setState] = useState<RepoAgentState | { missing: true } | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let cancelled = false;
		setState(null);
		setFailed(false);
		void loadRepoAgentState(owner, name)
			.then((value) => {
				if (!cancelled) setState(value);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [owner, name]);
	const saved = state && !("missing" in state) ? state : null;
	const presentation = agentStatePresentation(saved?.payload ?? null);
	return (
		<SectionRule title="管家备注">
			<LayerCard padding="md">
				{failed ? (
					<div role="status" className="flex flex-wrap items-center gap-2 text-sm">
						<span>管家备注暂时不可用</span>
						<Button size="sm" variant="outline" onClick={retry}>
							重试
						</Button>
					</div>
				) : !state ? (
					<p role="status" className="text-sm text-basalt-muted-foreground">
						读取管家备注…
					</p>
				) : !saved?.payload ? (
					<p className="text-sm text-basalt-muted-foreground">暂无管家备注</p>
				) : (
					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-2">
							<AgentStateBadge status={presentation.status} />
							{saved.repo_removed ? (
								<CandyBadge tone="gray">仓库已移除 · 备注保留</CandyBadge>
							) : null}
						</div>
						<p className="break-words text-sm">{presentation.summary ?? "未提供摘要"}</p>
						<DescriptionList columns={3}>
							<DescriptionList.Item term="最近审阅">
								{formatDate(presentation.lastReviewedAt)}
							</DescriptionList.Item>
							<DescriptionList.Item term="更新时间">
								{formatDate(saved.updated_at)}
							</DescriptionList.Item>
							<DescriptionList.Item term="修订">{saved.revision}</DescriptionList.Item>
						</DescriptionList>
					</div>
				)}
			</LayerCard>
		</SectionRule>
	);
}
