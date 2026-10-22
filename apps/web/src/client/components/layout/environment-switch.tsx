import { ConfirmDialog, SegmentControl, useConfirm } from "@nocoo/basalt";
import { useState } from "react";
import { apiPost } from "../../lib/api";
import { getLocalEnvironment } from "../../lib/local-environment";
import { INLINE_SEGMENT } from "./segment";

export function EnvironmentSwitch() {
	const environment = getLocalEnvironment();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const { confirm, dialogProps } = useConfirm();
	if (!environment) return null;
	return (
		<>
			<SegmentControl
				legend="数据源"
				className={`shrink-0 ${INLINE_SEGMENT} [&_[data-slot=segment-control-viewport]]:overflow-visible`}
				value={environment.mode}
				disabled={busy}
				options={[
					{ value: "local", label: "Local" },
					{ value: "prod", label: "Prod · 只读" },
				]}
				onValueChange={async (mode) => {
					if (mode === environment.mode || busy) return;
					setBusy(true);
					setError("");
					try {
						if (
							!(await confirm({
								title: "切换数据源？",
								description:
									"切换后返回软件工厂，未保存的输入将丢弃。Prod 仅查看线上数据，不能修改或刷新。",
								confirmLabel: "切换并返回首页",
								cancelLabel: "取消",
							}))
						)
							return;
						await apiPost("__local/environment", { mode });
						window.location.assign("/factory");
					} catch (cause) {
						setError(cause instanceof Error ? cause.message : "数据源切换失败");
					} finally {
						setBusy(false);
					}
				}}
			/>
			<ConfirmDialog {...dialogProps} />
			<ConfirmDialog
				open={!!error}
				onOpenChange={(open) => {
					if (!open) setError("");
				}}
				onConfirm={() => setError("")}
				title="数据源未切换"
				description={error}
				confirmLabel="知道了"
				cancelLabel="关闭"
			/>
		</>
	);
}
