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
					? "连接账号后，在软件工厂统一更新数据。"
					: "数据由软件工厂统一更新，可在那里查看进度或失败原因。"
			}
			action={
				<Button variant="secondary" size="sm" asChild>
					<Link href={needsAccount ? "/settings" : "/factory?refresh=1"}>
						{needsAccount ? "查看账号设置" : "前往刷新控制台"}
					</Link>
				</Button>
			}
		/>
	);
}
