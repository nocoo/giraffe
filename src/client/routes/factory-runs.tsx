import { Button, Checkbox, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "@nocoo/basalt";
import { Banner } from "@nocoo/basalt/components/banner";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@nocoo/basalt/components/dialog";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	AlertCircle,
	ArrowRight,
	CheckCircle2,
	Clock3,
	FolderSync,
	Info,
	LoaderCircle,
	Pause,
	Play,
	RefreshCw,
	Square,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { type FactoryRunResponse, type RunSelection, selectRunRepos } from "../../lib/factory-run";
import type { FactorySnapshot } from "../../lib/factory-types";
import { SearchField, SnapshotTime } from "../components/layout/collection-chrome";
import { SelectField } from "../components/layout/select-field";
import { factoryError, filterFactoryRepos, formatUtc } from "../viewmodels/factory";
import {
	controlFactoryRun,
	createRunPolling,
	factoryDataHealth,
	formatRunDuration,
	loadFactoryRuns,
	publicationKey,
	publishedReadNeeded,
	RUN_LABELS,
	secondsUntil,
	startFactoryRun,
	stepLabel,
} from "../viewmodels/factory-runs";
import { FactoryProgressBar, FactoryRunDetails } from "./factory-run-details";

export function FactoryRuns({
	snapshot,
	onPublished,
	filter,
	snapshotError,
	loading,
}: {
	snapshot: FactorySnapshot | null;
	onPublished: (account?: string) => Promise<void>;
	filter: { language: string; topic: string; query: string; repo: string };
	snapshotError: string;
	loading: boolean;
}) {
	const [data, setData] = useState<FactoryRunResponse | null>(null);
	const [error, setError] = useState("");
	const [pollError, setPollError] = useState("");
	const [busy, setBusy] = useState(false);
	const [params, setParams] = useSearchParams();
	const [open, setOpen] = useState(params.get("refresh") === "1");
	const [tab, setTab] = useState("");
	const [scope, setScope] = useState<RunSelection["scope"]>("all");
	const [selected, setSelected] = useState<string[]>([]);
	const [priority, setPriority] = useState<Record<string, number>>({});
	const [showPriority, setShowPriority] = useState(false);
	const [selectionQuery, setSelectionQuery] = useState("");
	const [historyId, setHistoryId] = useState("");
	const historyRef = useRef("");
	const [now, setNow] = useState(Date.now());
	const offset = useRef(0);
	const seenPublication = useRef<string | undefined>(undefined);
	const shownRef = useRef({ snapshot, loading });
	shownRef.current = { snapshot, loading };
	const accountRef = useRef<string | null>(null);
	const poll = useRef<ReturnType<typeof createRunPolling> | null>(null);
	const onPublishedRef = useRef(onPublished);
	onPublishedRef.current = onPublished;
	const intent = useRef<{ signature: string; key: string } | null>(null);
	useEffect(() => {
		poll.current = createRunPolling({
			load: () => loadFactoryRuns(historyRef.current),
			hidden: () => document.hidden,
			onError: (err) => setPollError(factoryError(err)),
			onData: (state) => {
				setData(state);
				setSelected((old) =>
					old.filter((name) => state.catalog.some((repo) => repo.name === name)),
				);
				offset.current = Date.parse(state.serverNow) - Date.now();
				setNow(Date.now() + offset.current);
				setPollError("");
				// The page's own initial read is still in flight; compare on the next poll instead.
				const shown = shownRef.current;
				if (!shown.loading || shown.snapshot) {
					if (publishedReadNeeded(seenPublication.current, state, shown.snapshot))
						void onPublishedRef
							.current(state.account_id)
							.catch((err) => setPollError(factoryError(err)));
					seenPublication.current = publicationKey(state);
				}
				if (accountRef.current !== state.account_id) {
					setSelected([]);
					setPriority({});
					setScope("all");
					setSelectionQuery("");
					setHistoryId("");
					historyRef.current = "";
					intent.current = null;
					setError("");
				}
				accountRef.current = state.account_id;
			},
		});
		const tick = setInterval(() => setNow(Date.now() + offset.current), 1000);
		return () => {
			poll.current?.stop();
			clearInterval(tick);
		};
	}, []);
	useEffect(() => {
		if (params.get("refresh") === "1") setOpen(true);
	}, [params]);
	function changeOpen(value: boolean) {
		setOpen(value);
		if (value) void poll.current?.refresh();
		else if (params.has("refresh"))
			setParams(
				(previous) => {
					const next = new URLSearchParams(previous);
					next.delete("refresh");
					return next;
				},
				{ replace: true },
			);
	}
	const catalog = data?.catalog ?? snapshot?.repos ?? [];
	const options = useMemo(() => filterFactoryRepos(catalog, filter), [catalog, filter]);
	const choices = useMemo(
		() =>
			filterFactoryRepos(scope === "filter" ? options : catalog, {
				language: "",
				topic: "",
				repo: "",
				query: selectionQuery,
			}),
		[options, catalog, scope, selectionQuery],
	);
	const planned = useMemo(
		() =>
			selectRunRepos(
				catalog,
				data?.repositories ?? [],
				{ ...filter, scope, repos: selected },
				new Date(now).toISOString(),
			),
		[catalog, data?.repositories, filter, scope, selected, now],
	);
	const health = useMemo(() => factoryDataHealth(snapshot), [snapshot]);
	const current = data?.current ?? null;
	const latest = current ?? data?.history[0] ?? null;
	const viewed = historyId ? data?.history.find((run) => run.id === historyId) : latest;
	const cooldown = secondsUntil(data?.nextAllowedAt ?? null, now);
	const activeTab = tab || (latest ? "progress" : "plan");
	const bannerError = snapshotError || pollError;
	const HealthIcon =
		bannerError || health.tone === "warning"
			? AlertCircle
			: health.tone === "success"
				? CheckCircle2
				: Info;
	function openLatest() {
		setHistoryId("");
		historyRef.current = "";
		setTab(latest ? "progress" : "plan");
		setOpen(true);
		void poll.current?.refresh();
	}
	async function start(mode: "catalog" | "refresh") {
		if (busy || current) return;
		setBusy(true);
		setError("");
		try {
			const names = planned
				.map((repo) => repo.name)
				.sort((a, b) => (priority[a] ?? 100) - (priority[b] ?? 100));
			const input = {
				mode,
				scope,
				...(scope === "selected" ? { repos: names, order: names } : { order: names }),
				...(scope === "filter" ? filter : {}),
			};
			const signature = JSON.stringify(input);
			if (intent.current?.signature !== signature)
				intent.current = { signature, key: crypto.randomUUID() };
			await startFactoryRun(input, intent.current.key);
			intent.current = null;
			setHistoryId("");
			historyRef.current = "";
			setTab("progress");
			await poll.current?.refresh();
		} catch (err) {
			setError(factoryError(err));
			await poll.current?.refresh();
		} finally {
			setBusy(false);
		}
	}
	async function control(action: "pause" | "resume" | "cancel") {
		if (!current || busy) return;
		setBusy(true);
		setError("");
		try {
			await controlFactoryRun(current.id, action);
			await poll.current?.refresh();
		} catch (err) {
			setError(factoryError(err));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<PageHeader
				title="软件工厂"
				description={
					snapshot
						? `${snapshot.owner} / GitHub · 从一次提交，到每一次交付`
						: "GitHub 的仓库、工作流与交付节奏"
				}
				actions={
					<DialogTrigger asChild>
						<Button size="sm">
							<RefreshCw className="size-3.5" aria-hidden="true" />
							刷新控制台
						</Button>
					</DialogTrigger>
				}
			/>
			<section
				className="factory-health-banner"
				data-tone={bannerError ? "warning" : health.tone}
				aria-label="数据健康与刷新进度"
			>
				<Banner
					size="sm"
					variant={bannerError || health.tone === "warning" ? "alert" : "secondary"}
					className="factory-health-message"
					icon={
						loading && !snapshot && !bannerError ? (
							<LoaderCircle className="animate-spin" aria-hidden="true" />
						) : (
							<HealthIcon aria-hidden="true" />
						)
					}
					description={
						<div className="factory-health-summary">
							<strong>
								{bannerError
									? "暂时无法读取最新状态"
									: loading && !snapshot
										? "正在读取工厂数据…"
										: health.title}
							</strong>
							<span>{bannerError || health.detail}</span>
							{snapshot ? (
								<SnapshotTime
									fetchedAt={snapshot.fetched_at}
									label={snapshot.publication?.mixed ? "快照更新" : "上次刷新"}
								/>
							) : null}
						</div>
					}
					action={
						<Banner.Action variant="ghost" onClick={openLatest}>
							查看详情
							<ArrowRight className="size-3.5" aria-hidden="true" />
						</Banner.Action>
					}
				/>
				{current ? (
					<div className="factory-banner-progress">
						<div className="factory-banner-run-label" role="status">
							{current?.status === "running" ? (
								<LoaderCircle className="animate-spin" aria-hidden="true" />
							) : current?.status === "paused" ? (
								<Pause aria-hidden="true" />
							) : (
								<Clock3 aria-hidden="true" />
							)}
							<span>
								{RUN_LABELS[current.status]}
								{current?.progress.current
									? ` · ${current.progress.current.repo ?? "账号"} / ${stepLabel(current.progress.current)}`
									: ""}
							</span>
						</div>
						<FactoryProgressBar run={current} label="列表页刷新进度" />
						<span className="factory-banner-count">
							{current.progress.completed} / {current.progress.total} 步
						</span>
						<Button variant="ghost" size="sm" onClick={openLatest}>
							查看进度
						</Button>
					</div>
				) : null}
			</section>
			<DialogContent
				size="xl"
				className="factory factory-console p-0 sm:w-[min(1180px,calc(100vw-3rem))]"
			>
				<header className="factory-console-header">
					<div className="factory-console-heading">
						<span className="factory-console-mark">
							<RefreshCw aria-hidden="true" />
						</span>
						<div>
							<DialogTitle className="text-xl">刷新控制台</DialogTitle>
							<DialogDescription>统一更新全站数据。关闭窗口后，刷新仍会继续。</DialogDescription>
						</div>
					</div>
					<DialogClose asChild>
						<Button size="icon" variant="ghost" aria-label="关闭刷新控制台">
							<X className="size-4" aria-hidden="true" />
						</Button>
					</DialogClose>
				</header>
				<Tabs value={activeTab} onValueChange={setTab} className="factory-console-tabs">
					<div className="factory-console-tabbar">
						<TabsList aria-label="刷新控制台功能">
							<TabsTrigger value="progress">刷新进度</TabsTrigger>
							<TabsTrigger value="plan">发起刷新</TabsTrigger>
						</TabsList>
						<span>{catalog.length} 个仓库</span>
					</div>
					<div className="factory-console-body">
						{!data && !pollError ? (
							<p role="status" className="factory-console-note">
								<LoaderCircle className="animate-spin" aria-hidden="true" />
								正在读取刷新状态…
							</p>
						) : null}
						{error || pollError ? (
							<div role="alert" className="factory-console-error">
								<AlertCircle aria-hidden="true" />
								<p>{error || pollError}</p>
								<Button size="sm" variant="secondary" onClick={() => void poll.current?.refresh()}>
									重试读取
								</Button>
							</div>
						) : null}
						{current ? (
							<div className="factory-active-controls">
								<div>
									<strong>当前任务 · {RUN_LABELS[current.status]}</strong>
									<p>暂停或结束后，已有数据保留。</p>
								</div>
								<Button
									size="sm"
									variant="secondary"
									disabled={busy}
									onClick={() => void control(current.status === "paused" ? "resume" : "pause")}
								>
									{current.status === "paused" ? (
										<Play className="size-3.5" aria-hidden="true" />
									) : (
										<Pause className="size-3.5" aria-hidden="true" />
									)}
									{current.status === "paused" ? "继续刷新" : "暂停刷新"}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() => void control("cancel")}
								>
									<Square className="size-3.5" aria-hidden="true" />
									结束本次刷新
								</Button>
							</div>
						) : null}
						<TabsContent value="progress" className="mt-0">
							<div className="factory-history-toolbar">
								<SelectField
									label="运行记录"
									value={historyId}
									onValueChange={(value) => {
										historyRef.current = value;
										setHistoryId(value);
										void poll.current?.refresh();
									}}
									options={[
										{ value: "", label: current ? "当前刷新" : "最近一次刷新" },
										...(data?.history ?? []).map((run) => ({
											value: run.id,
											label: `${formatUtc(run.startedAt)} · ${RUN_LABELS[run.status]} · ${run.mode === "catalog" ? "同步列表" : `${run.repos.length} 个仓库`}`,
										})),
									]}
								/>
								<Button size="sm" variant="ghost" onClick={() => void poll.current?.refresh()}>
									<RefreshCw className="size-3.5" aria-hidden="true" />
									更新状态
								</Button>
							</div>
							{viewed ? (
								viewed.steps.length ? (
									<FactoryRunDetails
										key={viewed.id}
										run={viewed}
										states={data?.repositories ?? []}
										now={now}
										onRetry={(names) => {
											setSelected(
												names.filter((name) => catalog.some((repo) => repo.name === name)),
											);
											setScope(names.length ? "selected" : "all");
											setSelectionQuery("");
											setTab("plan");
										}}
									/>
								) : (
									<p className="factory-console-empty" role="status">
										正在读取这次刷新的步骤明细…
									</p>
								)
							) : (
								<div className="factory-console-empty">
									<FolderSync aria-hidden="true" />
									<h3>还没有刷新记录</h3>
									<p>先同步仓库列表，再启动全站刷新。</p>
									<Button size="sm" onClick={() => setTab("plan")}>
										发起第一次刷新
									</Button>
								</div>
							)}
						</TabsContent>
						<TabsContent value="plan" className="factory-run-plan mt-0">
							<div className="factory-section-heading">
								<div>
									<h3>选择要更新的仓库</h3>
									<p>全站列表、通知、日报和所有仓库详情都会更新；下方范围用于工厂统计。</p>
								</div>
							</div>
							{current ? (
								<p className="factory-console-note">
									<Info aria-hidden="true" />
									已有任务正在进行。请等待完成，或结束当前任务后发起新的刷新。
								</p>
							) : null}
							<div className="factory-plan-scope">
								<SelectField
									label="刷新范围"
									value={scope}
									onValueChange={(value) => setScope(value as RunSelection["scope"])}
									options={[
										{ value: "selected", label: "手动选择仓库" },
										{
											value: "filter",
											label: `当前页面筛选（${options.length} 个）`,
											disabled: !data?.catalogComplete,
										},
										{
											value: "all",
											label: `全站刷新（${catalog.length} 个统计仓库）`,
											disabled: !data?.catalogComplete,
										},
										{
											value: "stale",
											label: "数据缺失或超过 24 小时未更新",
											disabled: !data?.catalogComplete,
										},
										{
											value: "failed",
											label: "上次刷新失败的仓库",
											disabled: !data?.catalogComplete,
										},
									]}
								/>
								<span>
									本次选择 <strong>{planned.length}</strong> 个仓库
								</span>
							</div>
							{!data?.catalogComplete ? (
								<p className="factory-console-note">
									<Info aria-hidden="true" />
									请先同步仓库列表，确认全站刷新需要覆盖的仓库。
								</p>
							) : null}
							{catalog.length ? (
								<>
									<div className="factory-selection-toolbar">
										<SearchField
											label="搜索可选仓库"
											placeholder="搜索仓库…"
											value={selectionQuery}
											onValueChange={setSelectionQuery}
										/>
										<div>
											{scope === "selected" ? (
												<>
													<Button
														size="sm"
														variant="ghost"
														onClick={() =>
															setSelected((old) => [
																...new Set([...old, ...choices.map((repo) => repo.name)]),
															])
														}
													>
														全选当前结果
													</Button>
													<Button
														size="sm"
														variant="ghost"
														disabled={!selected.length}
														onClick={() => setSelected([])}
													>
														清空选择
													</Button>
												</>
											) : null}
											<Button
												size="sm"
												variant="ghost"
												aria-pressed={showPriority}
												onClick={() => setShowPriority(!showPriority)}
											>
												{showPriority ? "收起优先级" : "设置优先级"}
											</Button>
										</div>
									</div>
									{scope === "filter" ? (
										<p className="factory-selection-hint">
											本次范围沿用主页面的语言、标签和搜索条件。
										</p>
									) : null}
									{showPriority ? (
										<p className="factory-selection-hint">
											数字越小越先刷新；相同数字按选择顺序执行。
										</p>
									) : null}
									<fieldset className="factory-run-select">
										<legend className="sr-only">选择仓库及优先级</legend>
										{choices.map((repo) => {
											const state = data?.repositories.find((item) => item.repo === repo.name);
											const wait = secondsUntil(state?.nextAllowedAt ?? null, now);
											return (
												<div key={repo.id} className="factory-run-select-row">
													<label htmlFor={`factory-select-${repo.id}`}>
														<Checkbox
															id={`factory-select-${repo.id}`}
															aria-label={repo.name}
															disabled={scope !== "selected"}
															checked={planned.some((item) => item.name === repo.name)}
															onCheckedChange={(checked) =>
																setSelected((old) =>
																	checked === true
																		? [...old, repo.name]
																		: old.filter((name) => name !== repo.name),
																)
															}
														/>
														<span>
															<strong>{repo.name}</strong>
															<small>
																{repo.language}
																{state
																	? ` · ${state.status === "success" ? "数据完整" : state.status === "partial" ? "部分数据未获取" : "上次未刷新成功"}`
																	: " · 尚未刷新"}
															</small>
														</span>
													</label>
													<span className="factory-selection-time">
														{wait
															? `${formatRunDuration(wait)} 后可刷新`
															: state?.refreshedAt
																? `更新于 ${formatUtc(state.refreshedAt)}`
																: "可开始刷新"}
													</span>
													{showPriority ? (
														<label
															className="factory-priority"
															htmlFor={`factory-priority-${repo.id}`}
														>
															优先级
															<Input
																id={`factory-priority-${repo.id}`}
																type="number"
																min="1"
																max="999"
																aria-label={`${repo.name} 优先级`}
																value={priority[repo.name] ?? 100}
																onChange={(event) =>
																	setPriority((old) => ({
																		...old,
																		[repo.name]: Math.max(
																			1,
																			Math.min(999, Number(event.target.value) || 100),
																		),
																	}))
																}
															/>
														</label>
													) : null}
												</div>
											);
										})}
										{!choices.length ? (
											<p className="factory-console-empty">没有符合筛选条件的仓库。</p>
										) : null}
									</fieldset>
								</>
							) : (
								<div className="factory-console-empty">
									<FolderSync aria-hidden="true" />
									<h3>先找到你的仓库</h3>
									<p>同步列表会发现当前账号的仓库，并读取已经保存的数据。</p>
								</div>
							)}
							<div className="factory-plan-footer">
								<p>
									{cooldown
										? `还需等待 ${formatRunDuration(cooldown)}，即可发起下一次刷新。`
										: "每个仓库刷新后需间隔 15 分钟；刚刷新过的仓库会自动跳过。"}
								</p>
								<div>
									<Button
										size="sm"
										variant="secondary"
										disabled={busy || !data || !!current || cooldown > 0}
										onClick={() => void start("catalog")}
									>
										<FolderSync className="size-3.5" aria-hidden="true" />
										同步仓库列表
									</Button>
									<Button
										size="sm"
										disabled={
											busy ||
											!data?.catalogComplete ||
											!!current ||
											cooldown > 0 ||
											(scope !== "all" && !planned.length)
										}
										onClick={() => void start("refresh")}
									>
										<Play className="size-3.5" aria-hidden="true" />
										开始刷新{planned.length ? `（${planned.length}）` : ""}
									</Button>
								</div>
							</div>
						</TabsContent>
						<details className="factory-diagnostics factory-storage">
							<summary>数据时间与存储用量</summary>
							<p>
								页面数据更新于 {formatUtc(snapshot?.fetched_at ?? null)}。
								{snapshot?.publication?.mixed
									? "各仓库使用各自最近可用的数据，更新时间可能不同。"
									: "刷新过程中，页面继续显示上次保存的数据。"}
							</p>
							<p>
								仓库列表更新于 {formatUtc(data?.catalogUpdatedAt ?? null)} · {catalog.length} 个仓库
								· {data?.catalogComplete ? "列表已完整获取" : "列表尚未完整获取"}。
							</p>
							{data?.storage ? (
								<p>
									全站数据占用{" "}
									{((data.storage.totalBytes ?? data.storage.resourceBytes) / 1e6).toFixed(1)} /{" "}
									{data.storage.limitBytes / 1e6} MB。保留最近 20
									次运行，以及当前页面使用的历史数据。
								</p>
							) : null}
							<Button
								size="sm"
								variant="ghost"
								onClick={() => void onPublished().catch((err) => setError(factoryError(err)))}
							>
								重新读取页面数据
							</Button>
						</details>
					</div>
				</Tabs>
				<footer className="factory-console-footer">
					<span>
						<Info aria-hidden="true" />
						关闭窗口不会停止刷新
					</span>
					<DialogClose asChild>
						<Button size="sm" variant="secondary">
							返回软件工厂
						</Button>
					</DialogClose>
				</footer>
			</DialogContent>
		</Dialog>
	);
}
