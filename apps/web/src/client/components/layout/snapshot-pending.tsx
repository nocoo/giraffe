import { Button, Link } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { Clock3 } from "lucide-react";
import { missingTitle } from "../../lib/error-ui";

export function SnapshotPending({
	state = { missing: true },
}: {
	state?: { missing: true; title?: unknown };
}) {
	const needsAccount = state.title === "请先连接 GitHub 账号";
	return (
		<LayerCard.Empty
			icon={<Clock3 />}
			title={missingTitle(state)}
			description={
				needsAccount
					? "连接账号后可查看已有快照。旧刷新已停用，当前无法采集新数据。"
					: "暂无已保存的快照。旧刷新已停用，当前无法采集新数据。"
			}
			action={
				needsAccount ? (
					<Button variant="secondary" size="sm" asChild>
						<Link href="/settings">查看账号设置</Link>
					</Button>
				) : (
					<Button variant="secondary" size="sm" disabled>
						刷新暂不可用
					</Button>
				)
			}
		/>
	);
}
