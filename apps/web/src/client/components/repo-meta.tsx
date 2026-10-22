import { Button } from "@nocoo/basalt";
import { DescriptionList } from "@nocoo/basalt/components/description-list";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { useEffect, useState } from "react";
import type { RepoMeta } from "../../lib/repo-meta";
import { formatDate } from "../lib/format";
import { categoryLabel, loadRepoMeta } from "../viewmodels/repo-meta";

export function RepoMetaCard({ owner, name }: { owner: string; name: string }) {
	const [attempt, setAttempt] = useState(0);
	return (
		<RepoMetaRead
			key={`${owner}/${name}/${attempt}`}
			owner={owner}
			name={name}
			retry={() => setAttempt((value) => value + 1)}
		/>
	);
}
function RepoMetaRead({ owner, name, retry }: { owner: string; name: string; retry: () => void }) {
	const [meta, setMeta] = useState<RepoMeta | { missing: true } | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void loadRepoMeta(owner, name)
			.then((value) => {
				if (!cancelled) setMeta(value);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [owner, name]);
	return (
		<SectionRule title="仓库档案">
			<LayerCard padding="md">
				{failed ? (
					<div role="status" className="flex flex-wrap items-center gap-2 text-sm">
						<span>仓库档案暂时不可用</span>
						<Button size="sm" variant="outline" onClick={retry}>
							重试
						</Button>
					</div>
				) : !meta ? (
					<p role="status" className="text-sm text-basalt-muted-foreground">
						读取仓库档案…
					</p>
				) : "missing" in meta ? (
					<p className="text-sm text-basalt-muted-foreground">暂无仓库档案</p>
				) : (
					<DescriptionList columns={2}>
						<DescriptionList.Item term="创建时间">
							{formatDate(meta.created_at)}
						</DescriptionList.Item>
						<DescriptionList.Item term="分类">{categoryLabel(meta.category)}</DescriptionList.Item>
					</DescriptionList>
				)}
			</LayerCard>
		</SectionRule>
	);
}
