import { Button, Input, Switch } from "@nocoo/basalt";
import { Label } from "@nocoo/basalt/components/label";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { useEffect, useRef, useState } from "react";
import type { RefreshSchedule, RefreshSettings } from "../../lib/refresh-schedule";
import { SelectField } from "../components/layout/select-field";
import { factoryError } from "../viewmodels/factory";
import {
	loadRefreshSettings,
	saveRefreshSchedule,
	scheduleStatus,
} from "../viewmodels/refresh-settings";

function ScheduleEditor({
	account,
	schedule,
	onSaved,
	onHistory,
}: {
	account: string;
	schedule: RefreshSchedule;
	onSaved: (settings: RefreshSettings) => void;
	onHistory: (id: string) => void;
}) {
	const [config, setConfig] = useState(schedule);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const label = schedule.kind === "daily" ? "每日快速刷新" : "每周深度刷新";
	return (
		<LayerCard>
			<LayerCard.Header>{label}</LayerCard.Header>
			<LayerCard.Body>
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						setBusy(true);
						setError("");
						setMessage("");
						void saveRefreshSchedule(account, schedule.kind, {
							enabled: config.enabled,
							time: config.time,
							weekday: config.weekday,
							scope: config.scope,
						})
							.then((result) => {
								onSaved(result);
								setMessage("已保存");
							})
							.catch((err) => setError(factoryError(err)))
							.finally(() => setBusy(false));
					}}
				>
					<div className="flex flex-wrap items-center gap-4">
						<Switch
							aria-label={`启用${label}`}
							checked={config.enabled}
							disabled={busy}
							onCheckedChange={(enabled) => setConfig((old) => ({ ...old, enabled }))}
						/>
						<div className="giraffe-select-field">
							<Label htmlFor={`schedule-time-${schedule.kind}`}>北京时间</Label>
							<Input
								id={`schedule-time-${schedule.kind}`}
								aria-label={`${label}时间`}
								className="w-28"
								type="time"
								required
								value={config.time}
								onChange={(event) => setConfig((old) => ({ ...old, time: event.target.value }))}
							/>
						</div>
						{schedule.kind === "weekly" ? (
							<>
								<SelectField
									label="每周日期"
									value={String(config.weekday)}
									onValueChange={(value) =>
										setConfig((old) => ({ ...old, weekday: Number(value) }))
									}
									options={["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map(
										(label, index) => ({ value: String(index), label }),
									)}
								/>
								<SelectField
									label="深度刷新范围"
									value={config.scope}
									onValueChange={(value) =>
										setConfig((old) => ({ ...old, scope: value as "all" | "starred" }))
									}
									options={[
										{ value: "all", label: "全站仓库" },
										{ value: "starred", label: "仅星标仓库" },
									]}
								/>
							</>
						) : (
							<span className="text-sm text-basalt-muted-foreground">仅 Giraffe 星标仓库</span>
						)}
						<Button type="submit" disabled={busy}>
							{busy ? "保存中…" : "保存计划"}
						</Button>
					</div>
					<div className="flex flex-wrap items-center gap-3 text-sm text-basalt-muted-foreground">
						<span>{scheduleStatus(schedule)}</span>
						{schedule.lastRunId ? (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => onHistory(schedule.lastRunId as string)}
							>
								查看上次执行
							</Button>
						) : null}
						<span role="status">{message}</span>
					</div>
					{error ? (
						<p role="alert" className="text-sm text-basalt-destructive">
							{error}
						</p>
					) : null}
				</form>
			</LayerCard.Body>
		</LayerCard>
	);
}
export function RefreshSchedules({
	account,
	onHistory,
}: {
	account: string;
	onHistory: (id: string) => void;
}) {
	const [data, setData] = useState<RefreshSettings | null>(null);
	const [error, setError] = useState("");
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		let timer: ReturnType<typeof setTimeout>;
		const load = async () => {
			try {
				const result = await loadRefreshSettings(account);
				if (mounted.current && result) {
					setData(result);
					setError("");
				}
			} catch (err) {
				if (mounted.current) setError(factoryError(err));
			} finally {
				if (mounted.current) timer = setTimeout(() => void load(), 30000);
			}
		};
		void load();
		return () => {
			mounted.current = false;
			clearTimeout(timer);
		};
	}, [account]);
	return (
		<div className="space-y-4">
			<p className="text-sm text-basalt-muted-foreground">
				已星标 {data?.starred.length ?? 0}{" "}
				个仓库。在仓库页面点亮星标后，每天自动更新；周深刷补齐历史变动。离开页面后任务仍会执行。
			</p>
			{error ? <p role="alert">{error}</p> : null}
			{data ? (
				data.schedules.map((schedule) => (
					<ScheduleEditor
						key={schedule.kind}
						account={account}
						schedule={schedule}
						onSaved={(result) => {
							if (mounted.current) setData(result);
						}}
						onHistory={onHistory}
					/>
				))
			) : (
				<p role="status">正在读取自动刷新计划…</p>
			)}
		</div>
	);
}
