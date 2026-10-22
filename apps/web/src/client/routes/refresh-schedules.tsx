import { Button, Input, Switch } from "@nocoo/basalt";
import { Label } from "@nocoo/basalt/components/label";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { useEffect, useRef, useState } from "react";
import {
	MAX_SCHEDULE_TIMES,
	type RefreshSchedule,
	type RefreshSettings,
} from "../../lib/refresh-schedule";
import { SelectField } from "../components/layout/select-field";
import { factoryError } from "../viewmodels/factory";
import {
	loadRefreshSettings,
	saveRefreshSchedule,
	scheduleStatus,
} from "../viewmodels/refresh-settings";

const scheduleDraft = (schedule: RefreshSchedule) => ({
	...schedule,
	times: schedule.times.map((time) => ({ id: crypto.randomUUID(), time })),
});

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
	const [config, setConfig] = useState(() => scheduleDraft(schedule));
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const label =
		schedule.kind === "catalog"
			? "每日同步仓库列表"
			: schedule.kind === "daily"
				? "每日快速刷新"
				: "每周深度刷新";
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
							times: config.times.map((slot) => slot.time),
							weekday: config.weekday,
							scope: config.scope,
						})
							.then((result) => {
								const saved = result.schedules.find((row) => row.kind === schedule.kind);
								if (saved) setConfig(scheduleDraft(saved));
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
							<div className="flex flex-wrap items-center gap-2">
								{config.times.map((slot, index) => (
									<div key={slot.id} className="flex items-center gap-1">
										<Input
											id={index === 0 ? `schedule-time-${schedule.kind}` : undefined}
											aria-label={`${label}时间${index === 0 ? "" : ` ${index + 1}`}`}
											className="w-28 scheme-light basalt-dark:scheme-dark"
											type="time"
											required
											disabled={busy}
											value={slot.time}
											onChange={(event) =>
												setConfig((old) => ({
													...old,
													times: old.times.map((entry) =>
														entry.id === slot.id ? { ...entry, time: event.target.value } : entry,
													),
												}))
											}
										/>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											aria-label={`${label}移除时间 ${index + 1}`}
											disabled={busy || config.times.length === 1}
											onClick={() =>
												setConfig((old) => ({
													...old,
													times: old.times.filter((entry) => entry.id !== slot.id),
												}))
											}
										>
											移除
										</Button>
									</div>
								))}
								<Button
									type="button"
									variant="outline"
									size="sm"
									aria-label={`${label}添加时间`}
									disabled={busy || config.times.length >= MAX_SCHEDULE_TIMES}
									onClick={() =>
										setConfig((old) => ({
											...old,
											times: [...old.times, { id: crypto.randomUUID(), time: "" }],
										}))
									}
								>
									添加时间
								</Button>
							</div>
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
							<span className="text-sm text-basalt-muted-foreground">
								{schedule.kind === "catalog" ? "当前账号全部仓库" : "仅 Giraffe 星标仓库"}
							</span>
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
				个仓库。每日快速刷新更新星标视图的统计、详情、Issues、PR、通知与
				Insights；每周深度刷新校准历史。每种计划可设置 1–6
				个北京时间（UTC+8），每周计划的所有时间使用同一日期。未处理时段会逐条保留；每日任务超过北京时间当日启动时限会单独记录失败。目录过旧时先自动同步，离开页面后任务仍会执行。
			</p>
			{error ? <p role="alert">{error}</p> : null}
			{data ? (
				data.schedules.map((schedule) => (
					<ScheduleEditor
						key={`${account}:${schedule.kind}`}
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
