import "./refresh.css";
import { Button, Checkbox, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@nocoo/basalt";
import { Banner } from "@nocoo/basalt/components/banner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import {
	AlertCircle,
	CalendarClock,
	Check,
	Clock3,
	FolderSync,
	Info,
	LoaderCircle,
	Play,
	RefreshCw,
	Square,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { REFRESH_DIMENSIONS, type RefreshRun } from "../../lib/refresh-types";
import { BusinessPageHeader as PageHeader } from "../components/layout/business-page-header";
import { CandyBadge } from "../components/layout/candy-badge";
import { TableScroll } from "../components/layout/collection-chrome";
import { useRefreshModel } from "../components/layout/refresh-provider";
import { NUM_CELL, NUM_HEAD } from "../lib/format";
import { isRemoteReadOnly } from "../lib/local-environment";
import {
	defaultRefreshParams,
	REFRESH_LABELS,
	refreshActive,
	refreshStatus,
	refreshTimezone,
	validateRefreshParams,
} from "../viewmodels/refresh";
import {
	type RefreshCenterState,
	RefreshCenterViewModel,
	refreshCurrentStep,
	refreshHistoryRows,
	refreshProgressOf,
	refreshScopeLabel,
} from "../viewmodels/refresh-center";
import { RefreshRunDetails } from "./refresh-run-details";

type RefreshModel = NonNullable<ReturnType<typeof useRefreshModel>>;

function historyTone(status: RefreshRun["status"]) {
	if (status === "completed") return "green" as const;
	if (status === "partial") return "amber" as const;
	if (status === "failed") return "red" as const;
	if (status === "cancelled") return "gray" as const;
	return "blue" as const;
}

function ProgressBar({ run, label }: { run: RefreshRun; label: string }) {
	const progress = refreshProgressOf(run);
	return (
		<div className="refresh-progress-track">
			<progress
				className="sr-only"
				max={progress.total}
				value={progress.processed}
				aria-label={label}
			/>
			<div className="refresh-progress-segments" aria-hidden="true">
				<span
					data-status="complete"
					style={{ width: `${(progress.complete / progress.total) * 100}%` }}
				/>
				<span
					data-status="partial"
					style={{ width: `${(progress.partial / progress.total) * 100}%` }}
				/>
				<span
					data-status="pending"
					style={{ width: `${(progress.pending / progress.total) * 100}%` }}
				/>
				<span
					data-status="skipped"
					style={{ width: `${(progress.skipped / progress.total) * 100}%` }}
				/>
			</div>
		</div>
	);
}

function PlanForm({
	center,
	live,
}: {
	center: RefreshCenterViewModel;
	live: RefreshCenterState["live"];
}) {
	const [params, setParams] = useState(defaultRefreshParams);
	const readOnly = isRemoteReadOnly();
	const invalid = validateRefreshParams(params);
	const busy = live.starting || refreshActive(live.run);
	const disabled =
		busy || live.loading || live.reading || !live.ready || !live.available || readOnly;
	return (
		<form
			className="refresh-plan"
			aria-label="发起统一刷新"
			onSubmit={(event) => {
				event.preventDefault();
				if (disabled || invalid) return;
				void center.start(params);
			}}
		>
			<div className="refresh-plan-scope">
				<p>
					一个任务先刷新 <strong>A · 账号信息、贡献趋势与仓库清单</strong>，再串行刷新{" "}
					<strong>B · 仓库</strong>。留空时范围为所有星标仓库，加上本账号上海当日新建且未观测的非
					fork 仓库；不会自动加星。
				</p>
				<CandyBadge tone="blue">无快速 / 深度模式</CandyBadge>
			</div>
			<div className="refresh-plan-grid">
				<label className="refresh-plan-field" data-wide="true" htmlFor="refresh-repo">
					指定仓库（可选）
					<Input
						id="refresh-repo"
						aria-label="指定仓库 owner/name"
						placeholder="owner/name；留空刷新默认范围"
						value={params.repo ?? ""}
						onChange={(event) => {
							const { repo: _repo, ...rest } = params;
							const value = event.target.value.trim();
							setParams(value ? { ...rest, repo: value } : rest);
						}}
					/>
				</label>
				<label className="refresh-plan-field" htmlFor="refresh-since">
					开始日期
					<Input
						id="refresh-since"
						type="date"
						aria-label="开始日期"
						value={params.since}
						onChange={(event) => setParams({ ...params, since: event.target.value })}
					/>
				</label>
				<label className="refresh-plan-field" htmlFor="refresh-until">
					结束日期
					<Input
						id="refresh-until"
						type="date"
						aria-label="结束日期"
						value={params.until}
						onChange={(event) => setParams({ ...params, until: event.target.value })}
					/>
				</label>
				<label className="refresh-plan-field" htmlFor="refresh-timezone">
					显示与缓存时区
					<Input
						id="refresh-timezone"
						aria-label="显示与缓存时区"
						value={params.timezone}
						onChange={(event) => setParams(refreshTimezone(params, event.target.value))}
					/>
				</label>
				<label className="refresh-plan-field" data-wide="true" htmlFor="refresh-force">
					<span className="flex items-center gap-basalt-space-lg">
						<Checkbox
							id="refresh-force"
							checked={params.force}
							onCheckedChange={(checked) => setParams({ ...params, force: checked === true })}
						/>
						强制重采已缓存日期
					</span>
				</label>
				<fieldset className="refresh-plan-dims" aria-label="刷新维度">
					<legend className="sr-only">刷新维度</legend>
					{REFRESH_DIMENSIONS.map((dimension) => (
						<label key={dimension} htmlFor={`refresh-dimension-${dimension}`}>
							<Checkbox
								id={`refresh-dimension-${dimension}`}
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
			</div>
			<p className="refresh-request-note">
				只刷新已结束的自然日，最多 31 天；不含今天和未来。依赖分析不采集，缺失保持 —。
			</p>
			{invalid ? (
				<p className="refresh-request-note" role="status">
					{invalid}
				</p>
			) : null}
			{readOnly ? (
				<p className="refresh-request-note">线上数据为只读，请切回 Local 后刷新。</p>
			) : null}
			{!live.available ? (
				<p className="refresh-request-note">当前采集不可用，已有快照仍可查看。</p>
			) : null}
			<div className="refresh-plan-footer">
				<p>刷新任务离开页面后仍会执行；已有任务进行中时不会重复发起。</p>
				<div>
					<Button type="submit" size="sm" disabled={disabled || Boolean(invalid)}>
						<Play className="size-3.5" aria-hidden="true" />
						{live.starting ? "正在发起…" : busy ? "刷新进行中" : "开始刷新"}
					</Button>
				</div>
			</div>
		</form>
	);
}

function RefreshCenterBody({ center }: { center: RefreshCenterViewModel }) {
	const state = useSyncExternalStore(center.subscribe, center.getSnapshot, center.getSnapshot);
	const [tab, setTab] = useState("progress");
	const current = state.live.run;
	const historyRows = refreshHistoryRows(state.runs, state.now);
	const currentProgress = current ? refreshProgressOf(current) : null;
	const currentActive = refreshActive(current);
	const bannerIcon = currentActive ? (
		<LoaderCircle className="animate-spin" aria-hidden="true" />
	) : current?.status === "failed" || current?.status === "partial" ? (
		<AlertCircle aria-hidden="true" />
	) : (
		<Check aria-hidden="true" />
	);
	return (
		<div className="refresh-center space-y-4">
			<PageHeader
				title="刷新中心"
				repositoryScope={false}
				description="统一管理账号 A、仓库 B 的刷新进度、运行记录与每日自动计划"
				actions={
					<Button size="sm" variant="secondary" asChild>
						<Link to="/factory">返回软件工厂</Link>
					</Button>
				}
			/>
			<section
				className="refresh-health"
				data-tone={current?.status === "failed" ? "warning" : "info"}
				aria-label="当前刷新状态"
			>
				<Banner
					size="sm"
					variant={current?.status === "failed" ? "alert" : "secondary"}
					className="refresh-health-message"
					icon={bannerIcon}
					description={
						current ? (
							<div className="refresh-health-summary">
								<strong>
									{refreshStatus(current)} · {refreshScopeLabel(current)}
								</strong>
								<span>{refreshCurrentStep(current)}</span>
								<span>
									{current.params.since} → {current.params.until} · {current.params.timezone}
								</span>
							</div>
						) : (
							<div className="refresh-health-summary">
								<strong>还没有刷新记录</strong>
								<span>
									默认覆盖星标仓库，以及本账号上海当日新建且未观测的非 fork
									仓库；没有快照时显示缺失，不代表零。
								</span>
							</div>
						)
					}
					action={
						<Banner.Action variant="ghost" onClick={() => void center.refreshAll()}>
							<RefreshCw aria-hidden="true" />
							更新状态
						</Banner.Action>
					}
				/>
				{current && currentActive ? (
					<div className="refresh-banner-progress">
						<div className="refresh-banner-run-label" role="status">
							<Clock3 aria-hidden="true" />
							<span>{refreshCurrentStep(current)}</span>
						</div>
						<ProgressBar run={current} label="当前刷新进度" />
						<span className="refresh-banner-count">
							{currentProgress?.processed} / {currentProgress?.total} 步
						</span>
						<Button
							variant="ghost"
							size="sm"
							disabled={!refreshActive(current) || current.cancelRequested || state.live.cancelling}
							onClick={() => void center.cancel()}
						>
							<Square className="size-3.5" aria-hidden="true" />
							{current.cancelRequested
								? "等待停止"
								: state.live.cancelling
									? "正在取消…"
									: "结束刷新"}
						</Button>
					</div>
				) : null}
			</section>
			<section className="refresh-console" aria-label="刷新管理">
				<Tabs value={tab} onValueChange={setTab} className="refresh-console-tabs">
					<div className="refresh-console-tabbar">
						<TabsList aria-label="刷新中心功能">
							<TabsTrigger value="progress">刷新进度</TabsTrigger>
							<TabsTrigger value="plan">发起刷新</TabsTrigger>
							<TabsTrigger value="schedule">自动刷新</TabsTrigger>
						</TabsList>
						<span>
							{state.runs.length} 次运行 · {current?.repos.length ?? 0} 个仓库
						</span>
					</div>
					<div className="refresh-console-body">
						{state.live.error ? (
							<div role="alert" className="refresh-console-error">
								<AlertCircle aria-hidden="true" />
								<p>{state.live.error}</p>
								<Button size="sm" variant="secondary" onClick={() => void center.refreshAll()}>
									重试读取
								</Button>
							</div>
						) : null}
						{state.error ? (
							<div role="alert" className="refresh-console-error">
								<AlertCircle aria-hidden="true" />
								<p>{state.error}</p>
								<Button size="sm" variant="secondary" onClick={() => void center.load()}>
									重试读取记录
								</Button>
							</div>
						) : null}
						<TabsContent value="progress" className="mt-0">
							<div className="refresh-history-toolbar">
								<span role="status">
									{state.loading && !state.runs.length
										? "正在读取刷新记录…"
										: state.selectedId
											? "正在查看历史运行；未执行的步骤保持未执行"
											: "进度表示已处理，不等于数据完整"}
								</span>
								<div>
									{state.selectedId ? (
										<Button size="sm" variant="ghost" onClick={() => center.select("")}>
											回到当前
										</Button>
									) : null}
									<Button size="sm" variant="ghost" onClick={() => void center.refreshAll()}>
										<RefreshCw className="size-3.5" aria-hidden="true" />
										更新记录
									</Button>
								</div>
							</div>
							{state.selected ? (
								<RefreshRunDetails
									key={state.selected.id}
									run={state.selected}
									now={state.now}
									{...(current?.id === state.selected.id
										? { onCancel: () => void center.cancel() }
										: {})}
									cancelling={state.live.cancelling}
								/>
							) : state.loading ? (
								<p className="refresh-console-note" role="status">
									<LoaderCircle className="animate-spin" aria-hidden="true" />
									正在读取刷新记录…
								</p>
							) : (
								<div className="refresh-console-empty">
									<FolderSync aria-hidden="true" />
									<h3>还没有刷新记录</h3>
									<p>发起第一次统一刷新后，会在这里保留 A / B 进度与结果。</p>
									<Button size="sm" onClick={() => setTab("plan")}>
										发起第一次刷新
									</Button>
								</div>
							)}
							{state.runs.length ? (
								<section aria-label="刷新记录" className="mt-6">
									<div className="refresh-section-heading">
										<h3>运行记录</h3>
										<span>最多显示最近 50 次；点击查看详情</span>
									</div>
									<TableScroll label="刷新记录">
										<Table className="refresh-history-table">
											<TableHeader>
												<TableRow>
													<TableHead>时间</TableHead>
													<TableHead>状态</TableHead>
													<TableHead>范围</TableHead>
													<TableHead className={NUM_HEAD}>耗时</TableHead>
													<TableHead className={NUM_HEAD}>请求</TableHead>
													<TableHead>问题仓库</TableHead>
													<TableHead />
												</TableRow>
											</TableHeader>
											<TableBody>
												{historyRows.map((row, index) => {
													const run = state.runs[index];
													if (!run) return null;
													const viewing = state.selected?.id === row.id;
													return (
														<TableRow key={row.id} aria-current={viewing ? "true" : undefined}>
															<TableCell className="whitespace-nowrap">{row.at}</TableCell>
															<TableCell>
																<CandyBadge tone={historyTone(run.status)}>{row.status}</CandyBadge>
															</TableCell>
															<TableCell>
																<span className="block">{row.scope}</span>
																<span className="block text-xs text-basalt-muted-foreground">
																	{run.trigger === "scheduled" ? "每日自动" : "手动"} ·{" "}
																	{run.completedRepos} / {run.repos.length} 仓库
																</span>
															</TableCell>
															<TableCell className={NUM_CELL}>{row.duration}</TableCell>
															<TableCell className={NUM_CELL}>{row.requests}</TableCell>
															<TableCell>
																<span
																	className="block max-w-56 truncate text-xs"
																	title={row.problems}
																>
																	{row.problems}
																</span>
															</TableCell>
															<TableCell>
																<Button
																	size="sm"
																	variant="ghost"
																	aria-label={`查看 ${row.at} 的运行详情`}
																	onClick={() =>
																		center.select(row.id === current?.id ? "" : row.id)
																	}
																>
																	{viewing ? "查看中" : "查看"}
																</Button>
															</TableCell>
														</TableRow>
													);
												})}
											</TableBody>
										</Table>
									</TableScroll>
								</section>
							) : null}
						</TabsContent>
						<TabsContent value="plan" className="mt-0">
							<PlanForm center={center} live={state.live} />
						</TabsContent>
						<TabsContent value="schedule" className="mt-0">
							<div className="refresh-plan-scope">
								<p>
									自动刷新由 Cloudflare Cron 在北京时间 03:00 发起，与手动刷新使用同一个 A → 串行 B
									任务和同一份运行记录。
								</p>
								<CandyBadge tone="green">
									<CalendarClock aria-hidden="true" />
									每日 03:00
								</CandyBadge>
							</div>
							<div className="refresh-schedule">
								<div>
									<h4>每日 03:00 Asia/Shanghai</h4>
									<p>同一账号同一天自动请求去重；已有任务进行时排队执行，不并行。</p>
								</div>
								<div>
									<h4>默认范围</h4>
									<p>所有星标仓库，加上本账号上海当日新建且未观测的非 fork 仓库；不会自动加星。</p>
								</div>
								<div>
									<h4>结果读取</h4>
									<p>页面仅展示已保存的运行结果；读取历史记录不会重新采集 GitHub 数据。</p>
								</div>
							</div>
							<p className="refresh-request-note">
								<Info className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
								自动刷新不可在页面中修改时间或启用状态；需要完整读取时请使用上方“发起刷新”。
							</p>
						</TabsContent>
					</div>
				</Tabs>
			</section>
		</div>
	);
}

export function RefreshCenter({ model }: { model: RefreshModel }) {
	const [center, setCenter] = useState<RefreshCenterViewModel | null>(null);
	useEffect(() => {
		const next = new RefreshCenterViewModel(model);
		setCenter(next);
		return () => next.dispose();
	}, [model]);
	if (!center) {
		return (
			<p role="status" className="text-sm text-basalt-muted-foreground">
				正在读取刷新状态…
			</p>
		);
	}
	return <RefreshCenterBody center={center} />;
}

export function RefreshPage() {
	const model = useRefreshModel();
	if (!model) {
		return (
			<p role="status" className="text-sm text-basalt-muted-foreground">
				正在读取刷新状态…
			</p>
		);
	}
	return <RefreshCenter model={model} />;
}
