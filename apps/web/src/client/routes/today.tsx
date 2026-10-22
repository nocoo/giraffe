import { toast } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { useState } from "react";
import type { ActivitySnapshot } from "../../lib/activity-types";
import { SnapshotPending } from "../components/layout/snapshot-pending";
import { useSnapshotRead } from "../components/layout/use-snapshot-read";
import { catchLoad } from "../lib/error-ui";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import { loadActivity } from "../viewmodels/activity";
import { ActivityContent, ActivityReadError } from "./activity-panels";

function ActivityRead({ repository }: { repository?: string }) {
	const [attempt, setAttempt] = useState(0);
	return (
		<ActivityReadState
			key={attempt}
			repository={repository}
			retry={() => setAttempt((value) => value + 1)}
		/>
	);
}

function ActivityReadState({
	repository,
	retry,
}: {
	repository: string | undefined;
	retry: () => void;
}) {
	const [snapshot, setSnapshot] = useState<
		ActivitySnapshot | { missing: true; title?: string } | null
	>(null);
	const [failed, setFailed] = useState(false);
	useSnapshotRead(
		() => loadActivity(repository),
		(value) => {
			setSnapshot(value);
			setFailed(false);
		},
		(error) => {
			const missing = catchLoad(error, (message) => toast.error(message));
			if (missing) setSnapshot(missing);
			setFailed(true);
		},
	);
	if (snapshot && "missing" in snapshot)
		return (
			<LayerCard>
				<SnapshotPending state={snapshot} />
			</LayerCard>
		);
	if (failed && !snapshot) return <ActivityReadError retry={retry} />;
	if (!snapshot)
		return (
			<LayerCard>
				<LayerCard.Loading label="加载当次活动" />
			</LayerCard>
		);
	return (
		<>
			{failed ? (
				<p role="status" className="text-sm">
					最新读取失败，以下保留上次成功读取的已保存窗口。
				</p>
			) : null}
			<ActivityContent snapshot={snapshot} repository={!!repository} />
		</>
	);
}

export function TodayPage() {
	return (
		<div className="giraffe-page-motion space-y-basalt-layout">
			<PageHeader title="今日活动" description={PAGE_DESCRIPTIONS["/today"]} />
			<ActivityRead />
		</div>
	);
}

export function RepoCurrentActivity({ repository }: { repository: string }) {
	return (
		<SectionRule title="当次活动" data-testid="repo-current-activity">
			<ActivityRead key={repository} repository={repository} />
		</SectionRule>
	);
}
