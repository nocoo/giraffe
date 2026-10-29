import { Button, Checkbox, Input } from "@nocoo/basalt";
import {
	Popover,
	PopoverContent,
	PopoverTitle,
	PopoverTrigger,
} from "@nocoo/basalt/components/popover";
import { RefreshCw } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { REFRESH_DIMENSIONS } from "../../../lib/refresh-types";
import { formatDate } from "../../lib/format";
import { isRemoteReadOnly } from "../../lib/local-environment";
import {
	defaultRefreshParams,
	REFRESH_LABELS,
	refreshActive,
	refreshProgress,
	refreshStatus,
	refreshTimezone,
} from "../../viewmodels/refresh";
import { useRefreshModel } from "./refresh-provider";

export function RefreshControl({ repo }: { repo?: string }) {
	const model = useRefreshModel();
	if (!model) return null;
	return <RefreshPanel model={model} {...(repo ? { repo } : {})} />;
}

function RefreshPanel({
	model,
	repo,
}: {
	model: NonNullable<ReturnType<typeof useRefreshModel>>;
	repo?: string;
}) {
	const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
	const [params, setParams] = useState(defaultRefreshParams);
	const title = useId();
	const busy = state.starting || refreshActive(state.run);
	const readOnly = isRemoteReadOnly();
	const disabled =
		busy || state.loading || state.reading || !state.ready || !state.available || readOnly;
	return (
		<Popover
			onOpenChange={(open) => {
				if (open) setParams(defaultRefreshParams());
			}}
		>
			<PopoverTrigger asChild>
				<Button
					size="sm"
					variant="secondary"
					className="shrink-0 whitespace-nowrap"
					aria-label={repo ? "刷新此仓库" : "刷新数据"}
				>
					<RefreshCw className="size-4" aria-hidden="true" />
					<span className={repo ? undefined : "hidden sm:inline"}>
						{busy ? "刷新中" : repo ? "刷新此仓库" : "刷新数据"}
					</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-labelledby={title}
				className="max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto"
			>
				<PopoverTitle id={title}>统一刷新</PopoverTitle>
				<p className="text-xs text-basalt-muted-foreground">
					{repo
						? `先刷新账号信息，再仅刷新 ${repo}，不改变星标。`
						: "先刷新账号信息与仓库清单，再串行刷新所有星标仓库（不限所有者），以及本账号上海当日新建且未观测的非 fork 仓库；不会自动加星。"}
				</p>
				<div role="status" aria-live="polite" className="space-y-1 text-sm tabular-nums">
					{state.loading || state.reading ? (
						"正在读取刷新状态…"
					) : state.run ? (
						<>
							<p>
								{refreshStatus(state.run)} · {refreshProgress(state.run)}
							</p>
							<p className="text-xs text-basalt-muted-foreground">
								{state.run.params.repo ?? "所有星标仓库 + 本账号上海当日新建且未观测的非 fork 仓库"}{" "}
								· {state.run.params.since} → {state.run.params.until} · {state.run.params.timezone}
							</p>
							<p className="text-xs text-basalt-muted-foreground">
								更新时间：{formatDate(state.run.updatedAt, state.run.params.timezone)}
							</p>
							{state.run.errorCode ? <p>错误代码：{state.run.errorCode}</p> : null}
							{state.run.status === "partial" || state.run.status === "failed" ? (
								<p>部分来源缺少数据，缺失不代表零；已有观测保留原始时间。</p>
							) : null}
						</>
					) : (
						"尚无刷新记录；没有快照时显示缺失，不代表零。"
					)}
				</div>
				{state.error ? (
					<div role="alert" className="space-y-2 text-sm">
						<p>{state.error}</p>
						<Button size="sm" variant="secondary" onClick={() => void model.read()}>
							重试读取状态
						</Button>
					</div>
				) : null}
				{readOnly ? <p className="text-sm">线上数据为只读，请切回 Local 后刷新。</p> : null}
				{!state.available ? <p className="text-sm">当前采集不可用，已有快照仍可查看。</p> : null}
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void model.start({ ...params, ...(repo ? { repo } : {}) });
					}}
				>
					<fieldset disabled={disabled} className="space-y-3">
						<details>
							<summary className="cursor-pointer text-sm">
								日期与维度 · 默认昨日（{params.timezone}）
							</summary>
							<div className="mt-3 space-y-3">
								<div className="grid grid-cols-2 gap-3">
									<label htmlFor={`${title}-since`} className="space-y-1 text-xs">
										开始日期
										<Input
											id={`${title}-since`}
											type="date"
											aria-label="开始日期"
											value={params.since}
											onChange={(event) => setParams({ ...params, since: event.target.value })}
										/>
									</label>
									<label htmlFor={`${title}-until`} className="space-y-1 text-xs">
										结束日期
										<Input
											id={`${title}-until`}
											type="date"
											aria-label="结束日期"
											value={params.until}
											onChange={(event) => setParams({ ...params, until: event.target.value })}
										/>
									</label>
								</div>
								<label htmlFor={`${title}-timezone`} className="block space-y-1 text-xs">
									显示时区
									<Input
										id={`${title}-timezone`}
										aria-label="显示时区"
										value={params.timezone}
										onChange={(event) => setParams(refreshTimezone(params, event.target.value))}
									/>
								</label>
								<p className="text-xs text-basalt-muted-foreground">
									最多 31 个已结束的自然日；不含今天和未来。更改时区会重置日期为该时区昨日。
								</p>
								<fieldset aria-label="刷新维度" className="grid grid-cols-2 gap-2">
									{REFRESH_DIMENSIONS.map((dimension) => (
										<label
											htmlFor={`${title}-${dimension}`}
											key={dimension}
											className="flex items-center gap-2 text-xs"
										>
											<Checkbox
												id={`${title}-${dimension}`}
												checked={params.dimensions.includes(dimension)}
												onCheckedChange={(checked) =>
													setParams({
														...params,
														dimensions:
															checked === true
																? [...params.dimensions, dimension]
																: params.dimensions.filter((value) => value !== dimension),
													})
												}
											/>
											{REFRESH_LABELS[dimension]}
										</label>
									))}
								</fieldset>
								<label htmlFor={`${title}-force`} className="flex items-center gap-2 text-xs">
									<Checkbox
										id={`${title}-force`}
										checked={params.force}
										onCheckedChange={(checked) => setParams({ ...params, force: checked === true })}
									/>
									强制重采已缓存日期
								</label>
							</div>
						</details>
						<Button type="submit" size="sm" disabled={disabled}>
							{busy ? "刷新进行中" : "开始刷新"}
						</Button>
					</fieldset>
				</form>
				<p className="text-xs text-basalt-muted-foreground">
					依赖分析不采集，缺失保持 —；依赖告警可刷新。
				</p>
				<p className="text-xs text-basalt-muted-foreground">
					每日 03:00 Asia/Shanghai 自动刷新星标仓库；GitHub管家 04:30 读取摘要（外部服务）。
				</p>
			</PopoverContent>
		</Popover>
	);
}
