import { Button, Input, SegmentControl } from "@nocoo/basalt";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { StatStrip } from "@nocoo/basalt/components/stat-strip";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import {
	Activity,
	ArrowLeft,
	ArrowUpRight,
	Boxes,
	CircleDot,
	GitCommitHorizontal,
	GitMerge,
	Workflow,
} from "lucide-react";
import {
	type CSSProperties,
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Link, useSearchParams } from "react-router";
import {
	FACTORY_STREAMS,
	type FactorySnapshot,
	type FactoryStreamName,
} from "../../lib/factory-types";
import { IconLabel } from "../components/layout/icon-label";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { LanguageLabel } from "../components/layout/labels";
import { ProjectLabel } from "../components/layout/project-identity";
import { SelectField } from "../components/layout/select-field";
import { FLOW_COLORS } from "../lib/chart-theme";
import { reportError } from "../lib/error-ui";
import {
	activityAge,
	dependencyEdges,
	type FactoryDetail,
	factoryBoard,
	factoryError,
	factoryGroups,
	factoryParams,
	factoryRepoCount,
	factoryRepoPage,
	filterFactoryRepos,
	formatHours,
	formatObservedCount,
	formatRate,
	formatUtc,
	hasFactoryMeasurement,
	loadFactory,
	loadFactoryDetail,
	formatFactoryCount as n,
	reloadFactory,
	STATUS_LABELS,
	STREAM_CODES,
	STREAM_LABELS,
	safeGithubUrl,
} from "../viewmodels/factory";
import { FactoryHeatmap, FactoryPanel, FactorySpark, FactoryTreemap } from "./factory-charts";
import { FactoryRepoTimes } from "./factory-repo-times";
import { FactoryRuns } from "./factory-runs";
import { ActivityBar, FactorySkeleton } from "./factory-skeleton";
import {
	ActivityQuadrant,
	BacklogPanel,
	CommitBreadthChart,
	DeliveryChart,
	FlowStockChart,
	PeriodStrip,
	RepoPeriodMatrix,
} from "./factory-story";

const FLOW_STYLE = {
	"--factory-issue": FLOW_COLORS.opened,
	"--factory-pr": FLOW_COLORS.release,
} as CSSProperties;

export function FactoryPage() {
	const [snapshot, setSnapshot] = useState<FactorySnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	const mounted = useRef(true);
	const [params, setParams] = useSearchParams();
	const [detail, setDetail] = useState<FactoryDetail | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState("");
	const [day, setDay] = useState("");
	const [repoPage, setRepoPage] = useState(1);
	const [calendar, setCalendar] = useState<"commits" | "contributions">("commits");
	const selected = params.get("repo") ?? "";
	const detailState = params.get("state") ?? "";
	const detailDay = params.get("day") ?? "";
	const language = params.get("language") ?? "";
	const topic = params.get("topic") ?? "";
	const query = params.get("q") ?? "";
	const streamRaw = params.get("stream") ?? "prs";
	const stream = FACTORY_STREAMS.includes(streamRaw as FactoryStreamName)
		? (streamRaw as FactoryStreamName)
		: "prs";
	const page = Math.max(1, Math.min(50, Number(params.get("page")) || 1));
	const period = ([1, 7, 30] as const).find((p) => String(p) === params.get("period")) ?? 7;
	const update = useCallback(
		(key: string, value: string) => {
			setParams((old) => factoryParams(old, key, value));
		},
		[setParams],
	);
	const drill = (repo: string, nextStream: FactoryStreamName = "prs") => {
		setParams((old) => {
			const next = new URLSearchParams(old);
			next.set("repo", repo);
			next.set("stream", nextStream);
			next.delete("state");
			next.delete("day");
			next.delete("page");
			return next;
		});
	};
	useEffect(() => {
		mounted.current = true;
		void loadFactory()
			.then((result) => {
				if (mounted.current) {
					setSnapshot("missing" in result ? null : result);
					setLoading(false);
				}
			})
			.catch((err) => {
				if (mounted.current) {
					reportError(err);
					setError(factoryError(err));
					setLoading(false);
				}
			});
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		let cancelled = false;
		setDetail(null);
		setDetailError("");
		if (!selected || !snapshot) return;
		setDetailLoading(true);
		void loadFactoryDetail(selected, stream, page, detailState, detailDay)
			.then((result) => {
				if (!cancelled) {
					if (result?.runId === snapshot.runId) setDetail(result);
					else setDetailError("调查已更新，请重新加载快照。");
					setDetailLoading(false);
				}
			})
			.catch((err) => {
				if (!cancelled) {
					setDetailError(factoryError(err));
					setDetailLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [selected, stream, page, snapshot, detailState, detailDay]);
	const readPublished = useCallback(async (account?: string) => {
		if (account) setSnapshot((old) => (old?.account_id === account ? old : null));
		const result = await reloadFactory();
		if (mounted.current) {
			setSnapshot("missing" in result ? null : result);
			setError("");
			setLoading(false);
		}
	}, []);
	const groups = useMemo(() => factoryGroups(snapshot?.repos ?? []), [snapshot]);
	// Typing stays responsive; the board and charts follow at lower priority.
	const deferredQuery = useDeferredValue(query);
	const scope = useMemo(
		() =>
			filterFactoryRepos(snapshot?.repos ?? [], {
				language,
				topic,
				query: deferredQuery,
				repo: selected,
			}),
		[snapshot, language, topic, deferredQuery, selected],
	);
	const board = useMemo(() => (snapshot ? factoryBoard(snapshot, scope) : null), [snapshot, scope]);
	const stale = deferredQuery !== query;
	const edges = useMemo(() => dependencyEdges(snapshot?.repos ?? []), [snapshot]);
	const visibleEdges = edges.filter(
		(e) => !selected || e.source === selected || e.target === selected,
	);
	const repo = scope[0];
	const ranking = factoryRepoPage(board?.ranking ?? [], repoPage);
	return (
		<div className="factory space-y-4" style={FLOW_STYLE}>
			<FactoryRuns
				snapshot={snapshot}
				onPublished={readPublished}
				filter={{ language, topic, query, repo: selected }}
				snapshotError={error}
				loading={loading}
			/>
			{loading && !snapshot ? <FactorySkeleton /> : null}
			{!loading && !snapshot ? (
				<FactoryPanel title="建立你的软件工厂视图" hint="使用当前 GitHub 账号">
					<p className="py-8 text-sm text-basalt-muted-foreground">
						同步仓库列表，再选择需要更新的仓库，即可查看提交、工作记录与交付趋势。
						刷新可以暂停，离开页面后也会继续。
					</p>
					<p className="pb-4 text-sm">点击右上角「刷新控制台」开始。</p>
				</FactoryPanel>
			) : null}
			{snapshot && board ? (
				<div className="factory-board" data-stale={stale || undefined}>
					<div className="factory-toolbar">
						<SelectField
							label="语言群"
							value={language}
							onValueChange={(value) => update("language", value)}
							options={[
								{ value: "", label: "全部语言" },
								...groups.languages.map((value) => ({ value, label: value })),
							]}
						/>
						<SelectField
							label="领域标签"
							value={topic}
							onValueChange={(value) => update("topic", value)}
							options={[
								{ value: "", label: "全部 topics" },
								...groups.topics.map((value) => ({ value, label: value })),
							]}
						/>
						<Input
							aria-label="搜索工厂仓库"
							placeholder="搜索仓库或描述…"
							value={query}
							onChange={(e) => update("q", e.target.value)}
							className="max-w-64"
						/>
						<span className="ml-auto text-xs text-basalt-muted-foreground">
							清单 {snapshot.inventory.scanned}/{snapshot.inventory.total} · 纳入{" "}
							{snapshot.repos.length} · 排除 {snapshot.inventory.excluded.length}
						</span>
					</div>
					{selected ? (
						<div className="flex flex-wrap items-center gap-3 text-sm">
							<Button size="sm" variant="ghost" onClick={() => update("repo", "")}>
								<ArrowLeft className="size-4" />
								返回仓库群
							</Button>
							<ProjectLabel repo={selected} className="font-semibold" />
							{repo?.private ? <span className="factory-tag">Private</span> : null}
							<Link className="factory-link ml-auto" to={`/repos/${selected}`}>
								原仓库详情 <ArrowUpRight className="size-3.5" />
							</Link>
						</div>
					) : null}
					{!scope.length ? (
						<div role="status" className="py-12 text-center text-sm">
							{snapshot.inventory.complete
								? "没有符合当前筛选的仓库。"
								: "仓库清单仍在分页采集中。"}{" "}
							<Button
								variant="ghost"
								className="factory-link"
								type="button"
								onClick={() => setParams({})}
							>
								重置筛选
							</Button>
						</div>
					) : (
						<>
							<PeriodStrip
								periods={board.periods}
								period={period}
								onPeriod={(value) => update("period", value === 7 ? "" : String(value))}
								totals={board.totals}
								activeRepos={board.activity.week}
							/>
							<section className="factory-section" aria-labelledby="factory-change-title">
								<SectionRule
									id="factory-change-title"
									title={<IconLabel icon={Activity}>变化 · 最近 90 天</IconLabel>}
									hint="左轴是每日流量（柱），右轴是结果（折线）。Open 存量由当前数量按每日新开与完成倒推；事件不完整时不画折线。"
								/>
								<div className="factory-chart-grid grid gap-3 xl:grid-cols-2">
									<FactoryPanel
										title="提交产出与覆盖面"
										hint="柱：每日默认分支提交（左轴）。线：截至当日 7 天内有提交的仓库数（右轴），看产出是集中在少数仓库还是全面推进。"
									>
										{board.observed.commits ? (
											<CommitBreadthChart days={board.days} />
										) : (
											<p className="factory-chart-empty">提交尚未采集。</p>
										)}
									</FactoryPanel>
									<FactoryPanel
										title="交付吞吐"
										hint="柱：每天合并的 PR 与发布的 Release（左轴）。线：截至当日 7 天 CI 成功率（右轴）。未完整获取的日期只显示已知数量，没有数据时留空。事件类别相加，不代表唯一工作项。"
									>
										{board.observed.prs || board.observed.releases ? (
											<DeliveryChart days={board.days} />
										) : (
											<p className="factory-chart-empty">交付资源尚未采集。</p>
										)}
									</FactoryPanel>
								</div>
								<div className="factory-chart-grid grid gap-3 xl:grid-cols-2">
									<FactoryPanel
										title="PR 流量与存量"
										hint="向上柱为每日新开 PR，向下为合并与未合并关闭（左轴）；阶梯线为日终 open PR 数（右轴）。"
									>
										{board.observed.prs ? (
											<FlowStockChart days={board.days} kind="prs" />
										) : (
											<p className="factory-chart-empty">PR 尚未采集。</p>
										)}
									</FactoryPanel>
									<FactoryPanel
										title="Issue 流量与存量"
										hint="向上柱为每日新开 Issue，向下为关闭（左轴）；阶梯线为日终 open Issue 数（右轴）。线上升说明积压在增加。"
									>
										{board.observed.issues ? (
											<FlowStockChart days={board.days} kind="issues" />
										) : (
											<p className="factory-chart-empty">Issue 尚未采集。</p>
										)}
									</FactoryPanel>
								</div>
								<FactoryPanel
									title="仓库变化矩阵"
									hint={`每行一个仓库。提交列为最近 1、7、30 个完整 UTC 日，颜色深浅按列内最大值；周环比对比前 7 天。PR 与 Issue 列使用上方选中的 ${period} 天区间，积压为当前 open 数。`}
									flush
								>
									<RepoPeriodMatrix
										activity={board.repoActivity}
										period={period}
										until={(name) =>
											(scope.find((r) => r.name === name)?.observation?.window ?? snapshot.window)
												.until
										}
										onSelect={(name) => drill(name, "commits")}
									/>
								</FactoryPanel>
							</section>
							<section className="factory-section" aria-labelledby="factory-stock-title">
								<SectionRule
									id="factory-stock-title"
									title={<IconLabel icon={Boxes}>存量 · 我名下全部仓库</IconLabel>}
									hint="当前时点的积累：规模、历史总量与未完成的工作。"
								/>
								<KpiRow>
									<Kpi
										icon={Boxes}
										label="仓库"
										value={n(board.totals.repos)}
										subtitle={`${board.totals.private} 私有 · ${(board.totals.sizeKiB / 1048576).toFixed(2)} GiB Git 存储`}
									>
										<ActivityBar activity={board.activity} />
									</Kpi>
									<Kpi
										icon={CircleDot}
										label="Open Issue / PR"
										value={`${n(board.totals.openIssues)} / ${n(board.totals.openPrs)}`}
										subtitle={`${n(board.aggregate.agedIssues + board.aggregate.agedPrs)} 个长龄 · Issue ≥14 天、PR ≥7 天`}
									>
										<FactorySpark
											values={board.days.map((d) => d.openIssues)}
											label="窗口内每日 open Issue"
											range={{ from: board.days[0]?.date ?? "", to: board.days.at(-1)?.date ?? "" }}
										/>
									</Kpi>
									<Kpi
										icon={GitCommitHorizontal}
										label="历史提交"
										value={n(board.totals.allCommits)}
										subtitle={`窗口内 ${
											board.observed.commits
												? formatObservedCount(
														board.aggregate.commits,
														board.streamComplete.commits === scope.length,
													)
												: "—"
										} · 默认分支`}
									>
										<FactorySpark
											values={board.days.map((d) =>
												d.complete.commits || d.commits ? d.commits : null,
											)}
											label="窗口内每日默认分支提交"
											range={{ from: board.days[0]?.date ?? "", to: board.days.at(-1)?.date ?? "" }}
										/>
									</Kpi>
									<Kpi
										icon={GitMerge}
										label="已合并 PR · 历史"
										value={n(board.totals.mergedPrs)}
										subtitle={`窗口内 ${
											board.observed.prs
												? formatObservedCount(
														board.aggregate.prMerged,
														board.streamComplete.prs === scope.length,
													)
												: "—"
										} · P50 ${formatHours(board.aggregate.cycleP50)} · P90 ${formatHours(board.aggregate.cycleP90)}`}
									>
										<FactorySpark
											values={board.days.map((d) =>
												d.complete.prs || d.prMerged ? d.prMerged : null,
											)}
											label="窗口内每日合并 PR"
											range={{ from: board.days[0]?.date ?? "", to: board.days.at(-1)?.date ?? "" }}
										/>
									</Kpi>
									<Kpi
										icon={Workflow}
										label="CI 观测成功率"
										value={board.observed.actions ? formatRate(board.aggregate.ciRate) : "—"}
										subtitle={
											board.observed.actions
												? `${n(board.aggregate.ciSuccess)} 成功 / ${n(board.aggregate.ciFailure)} 失败 · 窗口发布 ${n(board.aggregate.releases)}`
												: `尚未采集 · 完整 ${board.streamComplete.actions}/${scope.length} 仓`
										}
									>
										<FactorySpark
											values={board.days.map((d) => d.ciRate7)}
											label="窗口内 CI 7 日成功率"
											range={{ from: board.days[0]?.date ?? "", to: board.days.at(-1)?.date ?? "" }}
										/>
									</Kpi>
								</KpiRow>
								<div className="factory-chart-grid grid gap-3 xl:grid-cols-[1.15fr_1fr]">
									<FactoryPanel
										title={calendar === "commits" ? "提交日历" : "账号贡献日历"}
										hint={
											calendar === "commits"
												? "按提交时间（UTC）统计当前筛选的仓库。各仓库更新时间不同时，显示它们的日期并集，最多一年；斜纹表示未完整获取，不是零提交。"
												: "账号贡献无法按仓库排除，已停止展示。请使用参与统计仓库的提交日历。"
										}
									>
										<div className="mb-3 flex items-center justify-between gap-2">
											<SegmentControl
												legend="日历来源"
												value={calendar}
												options={[
													{ value: "commits", label: "仓库提交" },
													{ value: "contributions", label: "账号贡献", disabled: true },
												]}
												onValueChange={(value) => {
													setCalendar(value as typeof calendar);
													setDay("");
												}}
											/>
											<span className="text-xs text-basalt-muted-foreground">
												{calendar === "commits"
													? board.mixedWindows
														? "混合窗口 · 各日覆盖见账本"
														: `${n(board.periods[1]?.current.commits ?? 0)} / ${n(board.periods[1]?.previous.commits ?? 0)} · 近/前 7 个完整日`
													: snapshot.contribution
														? `${n(snapshot.contribution.total)} 贡献 · ${n(snapshot.contribution.restricted)} 受限贡献`
														: `${snapshot.contributionStatus === "pending" ? "未采集" : "不可用"}`}
											</span>
										</div>
										{calendar === "contributions" &&
										snapshot.contributionObservation &&
										snapshot.contributionStatus !== "complete" ? (
											<p className="mb-2 text-xs text-basalt-muted-foreground">
												本次未能更新，显示上次获取的日历。
											</p>
										) : null}
										{(
											calendar === "commits"
												? board.observed.commits
												: snapshot.contribution !== null
										) ? (
											<FactoryHeatmap
												days={
													calendar === "commits"
														? board.days.map((d) => ({
																date: d.date,
																count: d.commits,
																known: d.complete.commits,
															}))
														: (snapshot.contribution?.days ?? [])
												}
												selected={day}
												onSelect={setDay}
											/>
										) : (
											<p className="factory-chart-empty">当前范围的日历数据尚不可用。</p>
										)}
										{day ? (
											<p className="mt-3 text-xs" role="status">
												{day} UTC ·{" "}
												{calendar === "commits"
													? `${board.days.find((d) => d.date === day)?.commits ?? 0} 提交；已高亮每日账本；明细日期筛选独立。`
													: `${snapshot.contribution?.days.find((d) => d.date === day)?.count ?? 0} 账号贡献。`}
												<a
													className="factory-link ml-2"
													href={
														calendar === "commits"
															? "#factory-ledger"
															: `https://github.com/${snapshot.owner}?tab=overview&from=${day}&to=${day}`
													}
												>
													查看来源 ↗
												</a>
											</p>
										) : null}
									</FactoryPanel>
									<BacklogPanel activity={board.repoActivity} onSelect={drill} />
								</div>
								<div className="factory-chart-grid grid gap-3 xl:grid-cols-3">
									<FactoryPanel
										title="仓库规模地图"
										hint="面积按 GitHub 统计的语言字节数分配，不是代码行数。点击色块查看仓库；零字节仓库仍在下方表格中。"
									>
										<FactoryTreemap repos={scope} onSelect={(name) => drill(name, "commits")} />
										<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-basalt-muted-foreground">
											{board.languages.slice(0, 6).map((l) => (
												<span key={l.name} title={`${n(l.bytes)} bytes`}>
													<LanguageLabel name={l.name} /> <strong>{formatRate(l.share)}</strong>
												</span>
											))}
										</div>
										<details className="factory-methods mt-2">
											<summary>全部语言字节</summary>
											{board.languages.map((l) => (
												<p key={l.name}>
													<LanguageLabel name={l.name} /> · {n(l.bytes)} bytes ·{" "}
													{formatRate(l.share)}
												</p>
											))}
											<p>
												语言列表覆盖 {scope.filter((r) => r.languagesComplete).length}/
												{scope.length} 仓库。比例以返回的语言字节之和计算。
											</p>
										</details>
										<p className="mt-2 text-xs text-basalt-muted-foreground">
											{(board.totals.languageBytes / 1e6).toFixed(2)} MB 语言字节 · Git 磁盘{" "}
											{n(board.totals.sizeKiB)} KiB
										</p>
									</FactoryPanel>
									<FactoryPanel
										title="提交与待办"
										hint="每个点是一座仓库：横轴为最近 30 天提交（对数刻度），纵轴为当前 open Issue 与 PR，颜色为主语言。虚线为中位数；左上阴影区积压高于中位数、推进低于中位数，最值得检查。"
									>
										<ActivityQuadrant
											activity={board.repoActivity}
											onSelect={(name) => drill(name, "issues")}
										/>
									</FactoryPanel>
									<FactoryPanel
										title="工作流量账"
										hint="分别统计 Issue 与 PR 的创建、待处理和完成数量，不推断两者的关联。「期间」指当前统计窗口，Issue 按最后关闭时间计数。各阶段不一定是同一批工作项。"
									>
										<div className="factory-flow">
											<FlowRow
												label="Issues"
												values={[
													board.observed.issues ? board.aggregate.issueOpened : null,
													board.totals.openIssues,
													board.observed.issues ? board.aggregate.issueClosed : null,
												]}
												labels={["期间创建", "当前开放", "期间关闭"]}
											/>
											<FlowRow
												label="Pull requests"
												values={[
													board.observed.prs ? board.aggregate.prOpened : null,
													board.totals.openPrs,
													board.observed.prs ? board.aggregate.prMerged : null,
												]}
												labels={["期间创建", "当前开放", "期间合并"]}
											/>
										</div>
										<p className="mt-3 text-xs text-basalt-muted-foreground">
											另有 {n(board.aggregate.prClosed)} 个 PR 未合并关闭
										</p>
										<div className="mt-3 border-t border-basalt-border pt-3 text-xs">
											历史已关闭 Issue <strong>{n(board.totals.closedIssues)}</strong> · 历史已合并
											PR <strong>{n(board.totals.mergedPrs)}</strong>
										</div>
									</FactoryPanel>
								</div>
								<div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
									<FactoryPanel
										title="需要检查的信号"
										hint="PR 超过 7 天、Issue 超过 14 天仍未关闭，或 CI 至少运行 10 次且失败率不低于 20% 时提醒检查。这些信号不代表已经确认有问题。"
									>
										<div className="factory-signal-list">
											{board.anomalies.length ? (
												board.anomalies.map((a) => (
													<Button
														variant="ghost"
														type="button"
														key={`${a.repo}:${a.stream}`}
														onClick={() => drill(a.repo, a.stream)}
													>
														<ProjectLabel repo={a.repo} short />
														<span>{a.label}</span>
														<ArrowUpRight className="size-3.5" />
													</Button>
												))
											) : (
												<p className="py-3 text-xs text-basalt-muted-foreground">
													已观察资源未触发长龄/CI 失败率规则。
												</p>
											)}
										</div>
									</FactoryPanel>
									<FactoryPanel title="依赖与维护" hint="固定 SHA 的直接引用证据">
										<div className="flex flex-wrap gap-4 text-xs">
											<span>
												机器人开放 PR <strong>{board.aggregate.botOpen}</strong>
											</span>
											<span>
												窗口机器人合并 <strong>{board.aggregate.botMerged}</strong>
											</span>
											<span>
												观测引用边 <strong>{visibleEdges.length}</strong>
											</span>
										</div>
										<div className="factory-network mt-3">
											{visibleEdges.slice(0, 8).map((e) => (
												<div key={`${e.source}:${e.target}`}>
													<Button
														variant="ghost"
														type="button"
														onClick={() => drill(e.source, "dependencies")}
													>
														<ProjectLabel repo={e.source} short />
													</Button>
													<span className="factory-network-line" aria-hidden="true">
														→
													</span>
													<Button
														variant="ghost"
														type="button"
														onClick={() => drill(e.target, "dependencies")}
													>
														<ProjectLabel repo={e.target} short />
													</Button>
													<a
														href={safeGithubUrl(e.url)}
														target="_blank"
														rel="noreferrer"
														title="打开引用文件"
													>
														{e.references} 引用 ↗
													</a>
												</div>
											))}
											{!visibleEdges.length ? (
												<p className="py-3 text-xs text-basalt-muted-foreground">
													当前没有可解析为纳入仓库的直接引用。
												</p>
											) : null}
										</div>
										<details className="factory-methods mt-2">
											<summary>全部引用与范围</summary>
											<p>
												仅根 package.json 声明与 ci.yml / release.yml 中的 literal
												uses；不含传递依赖、monorepo 子包或动态引用。全局引用图不随语言/topic
												筛选缩减。
											</p>
											{visibleEdges.map((e) => (
												<p key={`${e.source}:${e.target}`}>
													<a href={safeGithubUrl(e.url)} target="_blank" rel="noreferrer">
														{e.source} → {e.target} · {e.references} 引用 ↗
													</a>
												</p>
											))}
										</details>
									</FactoryPanel>
								</div>
							</section>
							<FactoryPanel
								title={selected ? "仓库生产线" : "仓库生产线 · 按窗口提交量排序"}
								hint="每行是一条生产线，点击仓库或指标下钻"
								flush
							>
								<div className="factory-table-scroll">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>仓库 / 语言</TableHead>
												<TableHead>
													观测窗口节奏 · {board.days[0]?.date.slice(5) ?? ""} →{" "}
													{board.days.at(-1)?.date.slice(5) ?? ""}
												</TableHead>
												<TableHead className="text-right">提交</TableHead>
												<TableHead className="text-right">Open I / PR</TableHead>
												<TableHead className="text-right">合并 PR</TableHead>
												<TableHead className="text-right">CI 成功 / 判定</TableHead>
												<TableHead className="text-right">发布</TableHead>
												<TableHead>资源覆盖</TableHead>
												<TableHead className="text-right">时间</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{ranking.rows.map((r) => (
												<TableRow key={r.id}>
													<TableCell className="min-w-60 max-w-72">
														<Button
															variant="ghost"
															className="factory-repo-link max-w-full justify-start text-left whitespace-normal"
															type="button"
															onClick={() => drill(r.name)}
														>
															<ProjectLabel repo={r.name} />
														</Button>
														<div className="flex flex-wrap items-center gap-x-1.5 text-xs text-basalt-muted-foreground">
															<LanguageLabel name={r.language} />
															{r.private ? <span>· private</span> : null}
															{hasFactoryMeasurement(r, "commits") ? (
																<span>
																	· 最后提交{" "}
																	{activityAge(
																		board.repoActivity.find((a) => a.name === r.name)?.last,
																		(r.observation?.window ?? snapshot.window).until,
																	)}
																</span>
															) : null}
														</div>
													</TableCell>
													<TableCell>
														<span className="text-basalt-primary">
															{hasFactoryMeasurement(r, "commits") ? (
																<FactorySpark
																	values={board.days
																		.filter(
																			(d) =>
																				!r.observation ||
																				(d.date >= r.observation.window.since.slice(0, 10) &&
																					d.date <= r.observation.window.until.slice(0, 10)),
																		)
																		.map((d) => {
																			const count = r.metrics.days[d.date]?.commits ?? 0;
																			return r.coverage.commits.status === "complete" || count
																				? count
																				: null;
																		})}
																	label={`${r.name} 每日提交`}
																/>
															) : (
																<span title="提交数据未采集">未采集</span>
															)}
														</span>
													</TableCell>
													<TableCell className="text-right">
														<Button
															variant="ghost"
															className="factory-number"
															type="button"
															onClick={() => drill(r.name, "commits")}
														>
															{factoryRepoCount(r, "commits")}
														</Button>
													</TableCell>
													<TableCell className="text-right">
														<Button
															variant="ghost"
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "issues")}
														>
															{r.openIssues}
														</Button>{" "}
														/{" "}
														<Button
															variant="ghost"
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "prs")}
														>
															{r.openPrs}
														</Button>
													</TableCell>
													<TableCell className="text-right">
														<Button
															variant="ghost"
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "prs")}
														>
															{factoryRepoCount(r, "prs")}
														</Button>
													</TableCell>
													<TableCell className="text-right">
														<Button
															variant="ghost"
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "actions")}
														>
															{r.coverage.actions.status === "complete"
																? `${r.metrics.ciSuccess} / ${r.metrics.ciSuccess + r.metrics.ciFailure}`
																: "—"}
														</Button>
													</TableCell>
													<TableCell className="text-right">
														<Button
															variant="ghost"
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "releases")}
														>
															{factoryRepoCount(r, "releases")}
														</Button>
													</TableCell>
													<TableCell>
														<div className="factory-coverage-dots">
															{FACTORY_STREAMS.map((k) => (
																<Button
																	variant="ghost"
																	type="button"
																	key={k}
																	onClick={() => drill(r.name, k)}
																	className={`factory-coverage-${r.coverage[k].status}`}
																	title={`${STREAM_LABELS[k]}：${STATUS_LABELS[r.coverage[k].status]}`}
																	aria-label={`${r.name} ${STREAM_LABELS[k]}：${STATUS_LABELS[r.coverage[k].status]}`}
																>
																	{STREAM_CODES[k]}
																</Button>
															))}
														</div>
													</TableCell>
													<TableCell className="text-right">
														<FactoryRepoTimes repo={r} />
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
								{ranking.pages > 1 ? (
									<div className="flex items-center justify-end gap-2 px-4 py-3 text-xs">
										<span>
											仓库第 {ranking.current}/{ranking.pages} 页 · 每页 25 行
										</span>
										<Button
											size="sm"
											variant="secondary"
											disabled={ranking.current <= 1}
											onClick={() => setRepoPage(ranking.current - 1)}
										>
											前 25 仓库
										</Button>
										<Button
											size="sm"
											variant="secondary"
											disabled={ranking.current >= ranking.pages}
											onClick={() => setRepoPage(ranking.current + 1)}
										>
											后 25 仓库
										</Button>
									</div>
								) : null}
							</FactoryPanel>
							{selected ? (
								<FactoryPanel title={`${selected} · 工作记录`} hint="分页明细 · 每页 100 条">
									<SegmentControl
										legend="选择记录类型"
										value={stream}
										onValueChange={(value) => update("stream", value)}
										options={FACTORY_STREAMS.map((value) => ({
											value,
											label: STREAM_LABELS[value],
										}))}
									/>
									<div className="factory-toolbar mt-3">
										<SelectField
											label="状态"
											value={detailState}
											onValueChange={(value) => update("state", value)}
											options={[
												{ value: "", label: "全部状态" },
												{ value: "open", label: "Open" },
												{ value: "merged", label: "Merged" },
												{ value: "closed", label: "Closed" },
												{ value: "success", label: "CI success" },
												{ value: "failure", label: "CI failure" },
												{ value: "cancelled", label: "Cancelled" },
											]}
										/>
										<label htmlFor="factory-detail-day">
											{detailState === "merged"
												? "合并 UTC 日期"
												: detailState === "closed"
													? "关闭 UTC 日期"
													: "记录 UTC 日期"}{" "}
											<Input
												id="factory-detail-day"
												type="date"
												value={detailDay}
												onChange={(e) => update("day", e.target.value)}
												className="w-auto"
											/>
										</label>
									</div>
									{detailLoading ? (
										<p role="status" className="py-6 text-sm">
											读取记录…
										</p>
									) : detailError ? (
										<p role="alert" className="py-6 text-sm">
											{detailError}
										</p>
									) : detail ? (
										<>
											<div className="factory-provenance mt-3">
												<strong>{STATUS_LABELS[detail.coverage.status]}</strong>
												<span>
													{detail.total} 条观察记录 · 第 {page} 页
												</span>
												<span>{formatUtc(detail.coverage.fetchedAt)}</span>
											</div>
											{detail.coverage.reason ? (
												<p className="factory-notice">{detail.coverage.reason}</p>
											) : null}
											<p className="my-2 break-all text-xs text-basalt-muted-foreground">
												来源 {detail.coverage.source} · {detail.coverage.pages} API 页
											</p>
											{detail.items.length ? (
												<div className="factory-table-scroll">
													<Table>
														<TableHeader>
															<TableRow>
																<TableHead>记录</TableHead>
																<TableHead>状态 / 结论</TableHead>
																<TableHead>作者</TableHead>
																<TableHead>时间 UTC</TableHead>
																<TableHead>合并 / 关闭 UTC</TableHead>
															</TableRow>
														</TableHeader>
														<TableBody>
															{detail.items.map((e) => (
																<TableRow key={e.id}>
																	<TableCell>
																		<a
																			href={safeGithubUrl(e.url)}
																			target="_blank"
																			rel="noreferrer"
																			className="factory-detail-title"
																		>
																			{e.title || e.id}
																			<ArrowUpRight className="size-3 shrink-0" />
																		</a>
																		<div className="max-w-96 truncate text-xs text-basalt-muted-foreground">
																			{e.path ?? e.id}
																			{e.version ? ` · ${e.version}` : ""}
																		</div>
																	</TableCell>
																	<TableCell>
																		<span className="factory-tag">
																			{e.conclusion ?? e.state}
																			{e.draft ? " · draft" : ""}
																		</span>
																	</TableCell>
																	<TableCell>{e.author || "—"}</TableCell>
																	<TableCell className="whitespace-nowrap text-xs">
																		{e.at ? formatUtc(e.at) : "—"}
																	</TableCell>
																	<TableCell className="whitespace-nowrap text-xs">
																		{e.mergedAt || e.closedAt
																			? formatUtc(e.mergedAt ?? e.closedAt)
																			: "—"}
																	</TableCell>
																</TableRow>
															))}
														</TableBody>
													</Table>
												</div>
											) : (
												<p role="status" className="py-6 text-sm text-basalt-muted-foreground">
													{detail.coverage.status === "complete"
														? "该端点范围内没有记录。"
														: "尚无可读记录；不代表 GitHub 中为零。"}
												</p>
											)}
											<div className="mt-3 flex justify-end gap-2">
												<Button
													size="sm"
													variant="secondary"
													disabled={page <= 1}
													onClick={() => update("page", String(page - 1))}
												>
													上一页
												</Button>
												<Button
													size="sm"
													variant="secondary"
													disabled={page * 100 >= detail.total}
													onClick={() => update("page", String(page + 1))}
												>
													下一页
												</Button>
											</div>
										</>
									) : null}
								</FactoryPanel>
							) : null}
							<details
								className="factory-methods"
								id="factory-ledger"
								open={Boolean(day) && calendar === "commits"}
							>
								<summary>每日账本 · 可访问的图表数据与趋势核对</summary>
								<div className="factory-table-scroll">
									<Table>
										<caption className="sr-only">当前筛选内各日事件数，UTC</caption>
										<TableHeader>
											<TableRow>
												{[
													"UTC 日期",
													"提交",
													"Issue 创建",
													"Issue 最后关闭",
													"PR 创建",
													"PR 合并",
													"PR 未合并关闭",
													"CI 成功",
													"CI 失败",
													"Release",
												].map((h) => (
													<TableHead key={h}>{h}</TableHead>
												))}
											</TableRow>
										</TableHeader>
										<TableBody>
											{board.days.map((d) => (
												<TableRow
													key={d.date}
													variant={day === d.date ? "selected" : "default"}
													className={day === d.date ? "factory-ledger-selected" : ""}
												>
													<TableHead scope="row">{d.date}</TableHead>
													{[
														d.commits,
														d.issueOpened,
														d.issueClosed,
														d.prOpened,
														d.prMerged,
														d.prClosed,
														d.ciSuccess,
														d.ciFailure,
														d.releases,
													].map((value, i) => (
														<TableCell
															key={`${d.date}-${["commit", "issue", "close", "pr", "merge", "reject", "ci", "fail", "release"][i]}`}
														>
															{d.complete[
																(
																	[
																		"commits",
																		"issues",
																		"issues",
																		"prs",
																		"prs",
																		"prs",
																		"actions",
																		"actions",
																		"releases",
																	] as const
																)[i] ?? "commits"
															]
																? n(value)
																: value
																	? `≥ ${n(value)}`
																	: "—"}
														</TableCell>
													))}
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							</details>
						</>
					)}
					<details className="factory-methods">
						<summary>来源、口径与不确定性</summary>
						<p>
							页面数据更新于 {formatUtc(snapshot.fetched_at)}。
							{snapshot.publication?.mixed
								? "各仓库使用各自最近可用的数据，更新时间与统计范围可能不同。"
								: `统计范围：${formatUtc(snapshot.window.since)} → ${formatUtc(snapshot.window.until)}。`}
							所有时间为 UTC，最后一天尚未结束。
						</p>
						{selected && repo?.observation ? (
							<p>
								{selected}：数据更新于 {formatUtc(repo.observation.refreshedAt)}，统计范围{" "}
								{formatUtc(repo.observation.window.since)} →{" "}
								{formatUtc(repo.observation.window.until)}。
								{repo.observation.source === "legacy" ? "从历史记录恢复。" : "从 GitHub 获取。"}
							</p>
						) : null}
						<p>
							调查启动 {formatUtc(snapshot.window.until)}；仓库清单取样后逐资源分页，GitHub
							不提供跨端点原子快照。状态可能在采集过程中变化。清单覆盖仅限当前令牌可见仓库，包括私有仓库；无权读取的资源显示未知。
						</p>
						<p>
							提交：固定默认分支 SHA、所有作者、committer 时间；历史总量与 90
							天流量分开。账号贡献包含整个 GitHub
							账号的可见/受限活动，不随工厂仓库筛选变化。语言地图按 Linguist 字节，Git 存储按
							diskUsage KiB，均不是代码行数。
						</p>
						<p>
							PR P50/P90：窗口内合并样本 {board.aggregate.cycleHours.length}{" "}
							个的创建到合并耗时，nearest rank。不是首次 review 等待时间。Issue 关闭与 PR
							关闭只记录最后状态时间，不重建 reopen 转换。长龄规则表示需检查，不证明阻塞。
						</p>
						<p>
							CI 成功率仅使用 success 与 failure/timed_out/action_required/startup_failure
							的判定结果；取消、跳过等单列。以窗口内创建的 workflow run ID 去重，使用最新
							attempt；不含已删除或超保留期记录。Release 按 published_at，含 prerelease，不含
							draft。
						</p>
						<p>
							采集累计请求 {snapshot.requests}；最近响应额度{" "}
							{snapshot.rate
								? `${snapshot.rate.resource} ${snapshot.rate.remaining}，重置 ${formatUtc(snapshot.rate.resetAt)}`
								: "此导入快照未记录最近额度"}
							。每条队列消息至多 1 页 / 一个逻辑动作，资源至多 5,000 条或 1.2
							MB；截断数据只表示观察子集。已完成资源在续传时复用；更新调查重新取样。
						</p>
						<p>
							topics 是 GitHub 作者设置的标签，可重叠，不能把标签分组总数相加。引用图只使用可定位的
							manifest/工作流证据。
						</p>
						<details>
							<summary>排除清单（互斥归因）</summary>
							<div className="factory-exclusions">
								{snapshot.inventory.excluded.map((r) => (
									<span key={r.name}>
										{r.name} · {r.reason}
									</span>
								))}
							</div>
						</details>
					</details>
				</div>
			) : null}
		</div>
	);
}
function FlowRow({
	label,
	values,
	labels,
}: {
	label: string;
	values: (number | null)[];
	labels: string[];
}) {
	return (
		<div>
			<h3>{label}</h3>
			<StatStrip
				className="grid-cols-3 md:grid-cols-3 [&>div]:p-3"
				items={values.map((value, index) => ({
					label: labels[index],
					value: value === null ? "—" : n(value),
				}))}
			/>
		</div>
	);
}
