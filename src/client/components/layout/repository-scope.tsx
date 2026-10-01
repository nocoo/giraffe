import { Button, SegmentControl } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Star } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Outlet } from "react-router";
import {
	getRepositoryScope,
	setRepositoryScope,
	subscribeRepositoryScope,
} from "../../viewmodels/scope";

export function useRepositoryScope() {
	return useSyncExternalStore(subscribeRepositoryScope, getRepositoryScope, getRepositoryScope);
}

export function BusinessOutlet() {
	const scope = useRepositoryScope();
	return (
		<div className="space-y-4">
			<SegmentControl
				legend="仓库范围"
				className="[&>legend]:float-left [&>legend]:mr-3 [&>legend]:pt-1.5 [&_[data-slot=segment-control-viewport]]:pb-0"
				value={scope}
				onValueChange={(value) => setRepositoryScope(value === "all" ? "all" : "starred")}
				options={[
					{ value: "starred", label: "星标" },
					{ value: "all", label: "全部" },
				]}
			/>
			<Outlet key={scope} />
		</div>
	);
}

export function ScopeEmpty({ count }: { count: number }) {
	const scope = useRepositoryScope();
	if (scope !== "starred" || count !== 0) return null;
	return (
		<LayerCard.Empty
			icon={<Star />}
			title="当前星标范围暂无数据"
			description="可查看全部仓库的已有数据，或在仓库页添加星标。切换范围不会触发采集。"
			action={
				<Button size="sm" variant="secondary" onClick={() => setRepositoryScope("all")}>
					查看全部仓库
				</Button>
			}
		/>
	);
}
