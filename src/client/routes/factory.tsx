import { Button, Input } from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { ArrowLeft, ArrowUpRight, GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
	FACTORY_STREAMS,
	type FactorySnapshot,
	type FactoryStreamName,
} from "../../lib/factory-types";
import { reportError } from "../lib/error-ui";
import {
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
import {
	FactoryHeatmap,
	FactoryPanel,
	FactoryScatter,
	FactorySpark,
	FactoryThroughput,
	FactoryTreemap,
} from "./factory-charts";
import { FactoryRuns } from "./factory-runs";

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
	const fail = (err: unknown) => {
		reportError(err);
		setError(factoryError(err));
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
	const readPublished = useCallback(async () => {
		const result = await reloadFactory();
		if (!("missing" in result)) setSnapshot(result);
	}, []);
	const groups = useMemo(() => factoryGroups(snapshot?.repos ?? []), [snapshot]);
	const scope = useMemo(
		() => filterFactoryRepos(snapshot?.repos ?? [], { language, topic, query, repo: selected }),
		[snapshot, language, topic, query, selected],
	);
	const board = useMemo(() => (snapshot ? factoryBoard(snapshot, scope) : null), [snapshot, scope]);
	const edges = useMemo(() => dependencyEdges(snapshot?.repos ?? []), [snapshot]);
	const visibleEdges = edges.filter(
		(e) => !selected || e.source === selected || e.target === selected,
	);
	const repo = scope[0];
	const ranking = factoryRepoPage(board?.ranking ?? [], repoPage);
	const actions = (
		<Button size="sm" variant="ghost" onClick={() => void readPublished().catch(fail)}>
			读取已发布快照
		</Button>
	);
	return (
		<div className="factory space-y-4">
			<PageHeader
				title="软件工厂"
				description={
					snapshot
						? `${snapshot.owner} / GitHub · 从生产节奏到每一条工作记录`
						: "GitHub 的仓库、工作流与交付节奏"
				}
				actions={actions}
			/>
			<FactoryRuns
				snapshot={snapshot}
				onPublished={readPublished}
				filter={{ language, topic, query, repo: selected }}
			/>
			{error ? (
				<div role="alert" className="factory-notice factory-warning">
					{error} <Link to="/settings">账号设置 ↗</Link>
				</div>
			) : null}
			{loading && !snapshot ? (
				<div role="status" className="factory-loading">
					正在读取工厂快照…
					<div />
					<div />
					<div />
				</div>
			) : null}
			{!loading && !snapshot ? (
				<FactoryPanel title="建立你的软件工厂视图" hint="使用当前 GitHub 账号">
					<p className="py-8 text-sm text-basalt-muted-foreground">
						首次调查完整分页读取归属仓库，再分批采集 90 天窗口的提交、历史 Issue /
						PR、Actions、Release 与依赖证据。进度可暂停和续传。
					</p>
					<p className="pb-4 text-sm">请在上方刷新控制台发现仓库，然后选择刷新范围。</p>
				</FactoryPanel>
			) : null}
			{snapshot && board ? (
				<>
					<div className="factory-provenance">
						<span className="factory-status-dot" />
						<strong>
							{snapshot.publication?.mixed
								? "混合版本 · 保留历史成功数据"
								: snapshot.status === "complete"
									? "已保存的 GitHub 观察"
									: "旧调查未完成 · 可恢复已有资源"}
						</strong>
						<span>
							{snapshot.window.since.slice(0, 10)} → {snapshot.window.until.slice(0, 10)} ·{" "}
							{snapshot.publication?.mixed ? "仓库分别采样 /" : "90 天 /"}
							UTC / 末日未满
						</span>
						<span className="ml-auto">更新 {formatUtc(snapshot.fetched_at)}</span>
					</div>
					{selected && repo?.observation ? (
						<div className="factory-run-meta">
							<span>
								事件窗口 {formatUtc(repo.observation.window.since)} →{" "}
								{formatUtc(repo.observation.window.until)}
							</span>
							<span>
								仓库快照 {formatUtc(repo.observation.refreshedAt)} ·{" "}
								{repo.observation.source === "legacy" ? "旧资源恢复" : "GitHub 采集"}
							</span>
						</div>
					) : null}
					<div className="factory-toolbar">
						<label>
							语言群{" "}
							<select
								value={language}
								onChange={(e) => {
									update("language", e.target.value);
								}}
							>
								<option value="">全部语言</option>
								{groups.languages.map((g) => (
									<option key={g}>{g}</option>
								))}
							</select>
						</label>
						<label>
							领域标签{" "}
							<select value={topic} onChange={(e) => update("topic", e.target.value)}>
								<option value="">全部 topics</option>
								{groups.topics.map((g) => (
									<option key={g}>{g}</option>
								))}
							</select>
						</label>
						<Input
							aria-label="搜索工厂仓库"
							placeholder="搜索仓库或描述…"
							value={query}
							onChange={(e) => update("q", e.target.value)}
							className="h-8 max-w-64 text-xs"
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
							<GitBranch className="size-4" />
							<strong>{selected}</strong>
							{repo?.private ? <span className="factory-tag">Private</span> : null}
							<Link className="factory-link ml-auto" to={`/repos/${selected}`}>
								原仓库详情 <ArrowUpRight className="size-3.5" />
							</Link>
						</div>
					) : null}
					{board.coverage.complete < board.coverage.total ? (
						<div className="factory-notice">
							<strong>
								数据覆盖 {board.coverage.complete}/{board.coverage.total}
							</strong>
							<span>
								{" "}
								个仓库资源完整 · {board.coverage.unavailable} 不可用 · {board.coverage.limited}{" "}
								截断。图表仅累计已结束资源的观测值，未覆盖部分不是零。
							</span>
							{snapshot.status === "collecting" ? (
								<span>
									{" "}
									当前：{snapshot.repos[snapshot.cursor.repo]?.name ?? "仓库清单"} /{" "}
									{STREAM_LABELS[FACTORY_STREAMS[snapshot.cursor.stream] ?? "commits"]}
								</span>
							) : null}
						</div>
					) : null}
					{!scope.length ? (
						<div role="status" className="py-12 text-center text-sm">
							{snapshot.inventory.complete
								? "没有符合当前筛选的仓库。"
								: "仓库清单仍在分页采集中。"}{" "}
							<button className="factory-link" type="button" onClick={() => setParams({})}>
								重置筛选
							</button>
						</div>
					) : (
						<>
							<div className="factory-metric-strip">
								<Metric
									label="窗口提交"
									value={
										board.observed.commits
											? formatObservedCount(
													board.aggregate.commits,
													board.streamComplete.commits === scope.length,
												)
											: "—"
									}
									note={`${n(board.totals.allCommits)} 默认分支历史总量`}
								>
									<FactorySpark
										values={board.days.map((d) => d.commits)}
										label="窗口内每日默认分支提交"
									/>
								</Metric>
								<Metric
									label="在制工作 · 清单时点"
									value={`${n(board.totals.openIssues)} / ${n(board.totals.openPrs)}`}
									note="Open issue / Open PR"
								>
									<span className="text-xs text-basalt-muted-foreground">
										{n(board.aggregate.agedIssues + board.aggregate.agedPrs)} 个长龄信号
									</span>
								</Metric>
								<Metric
									label="窗口合并 PR"
									value={
										board.observed.prs
											? formatObservedCount(
													board.aggregate.prMerged,
													board.streamComplete.prs === scope.length,
												)
											: "—"
									}
									note={`P50 ${formatHours(board.aggregate.cycleP50)} · P90 ${formatHours(board.aggregate.cycleP90)}`}
								>
									<FactorySpark
										values={board.days.map((d) => d.prMerged)}
										label="窗口内每日合并 PR"
									/>
								</Metric>
								<Metric
									label="CI 观测成功率"
									value={board.observed.actions ? formatRate(board.aggregate.ciRate) : "—"}
									note={
										board.observed.actions
											? `${n(board.aggregate.ciSuccess)} 成功 / ${n(board.aggregate.ciFailure)} 失败 · 完整 ${board.streamComplete.actions}/${scope.length} 仓`
											: `尚未采集 · 完整 ${board.streamComplete.actions}/${scope.length} 仓`
									}
								>
									<span className="text-xs text-basalt-muted-foreground">
										{n(board.aggregate.ciOther)} 其他 · {board.aggregate.ciPending} 进行中
									</span>
								</Metric>
								<Metric
									label="窗口发布"
									value={
										board.observed.releases
											? formatObservedCount(
													board.aggregate.releases,
													board.streamComplete.releases === scope.length,
												)
											: "—"
									}
									note={`${board.totals.repos} 仓库 · ${board.totals.private} 私有`}
								>
									<span className="text-xs text-basalt-muted-foreground">
										{(board.totals.sizeKiB / 1048576).toFixed(2)} GiB Git 存储
									</span>
								</Metric>
							</div>
							<div className="grid gap-3 xl:grid-cols-[1.15fr_1fr]">
								<FactoryPanel
									title={calendar === "commits" ? "提交日历" : "账号贡献日历"}
									hint={
										calendar === "commits"
											? "当前筛选 · committer date"
											: "整个账号 · 包括外部/排除仓库，不随筛选变化"
									}
								>
									<div className="mb-3 flex items-center justify-between gap-2">
										<div className="factory-switch">
											<button
												type="button"
												aria-pressed={calendar === "commits"}
												onClick={() => {
													setCalendar("commits");
													setDay("");
												}}
											>
												仓库提交
											</button>
											<button
												type="button"
												aria-pressed={calendar === "contributions"}
												onClick={() => {
													setCalendar("contributions");
													setDay("");
												}}
											>
												账号贡献
											</button>
										</div>
										<span className="text-xs text-basalt-muted-foreground">
											{calendar === "commits"
												? `${board.trend.recent} / ${board.trend.previous} · 近/前 7 个完整日`
												: snapshot.contribution
													? `${n(snapshot.contribution.total)} 贡献 · ${n(snapshot.contribution.restricted)} 受限贡献`
													: `${snapshot.contributionStatus === "pending" ? "未采集" : "不可用"}`}
										</span>
									</div>
									{(
										calendar === "commits"
											? board.observed.commits
											: snapshot.contribution !== null
									) ? (
										<FactoryHeatmap
											days={
												calendar === "commits"
													? board.days.map((d) => ({ date: d.date, count: d.commits }))
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
								<FactoryPanel title="交付吞吐" hint="每日合并 PR + 未合并关闭 + Release">
									{board.observed.prs || board.observed.releases ? (
										<FactoryThroughput days={board.days} />
									) : (
										<p className="factory-chart-empty">交付资源尚未采集。</p>
									)}
									<div className="factory-chart-key">
										<span>● 合并 PR</span>
										<span>● 未合并关闭</span>
										<span>● Release</span>
										<span className="ml-auto">事件类别相加，不代表唯一工作项</span>
									</div>
								</FactoryPanel>
							</div>
							<div className="grid gap-3 xl:grid-cols-3">
								<FactoryPanel title="仓库规模地图" hint="面积 = Linguist 语言字节 · 点击下钻">
									<FactoryTreemap repos={scope} onSelect={(name) => drill(name, "commits")} />
									<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-basalt-muted-foreground">
										{board.languages.slice(0, 6).map((l) => (
											<span key={l.name} title={`${n(l.bytes)} bytes`}>
												{l.name} <strong>{formatRate(l.share)}</strong>
											</span>
										))}
									</div>
									<details className="factory-methods mt-2">
										<summary>全部语言字节</summary>
										{board.languages.map((l) => (
											<p key={l.name}>
												{l.name} · {n(l.bytes)} bytes · {formatRate(l.share)}
											</p>
										))}
										<p>
											语言列表覆盖 {scope.filter((r) => r.languagesComplete).length}/{scope.length}{" "}
											仓库。比例以返回的语言字节之和计算。
										</p>
									</details>
									<p className="mt-2 text-[11px] text-basalt-muted-foreground">
										{(board.totals.languageBytes / 1e6).toFixed(2)} MB 语言字节 · Git 磁盘{" "}
										{n(board.totals.sizeKiB)} KiB
									</p>
								</FactoryPanel>
								<FactoryPanel title="流量 × 在制品" hint="仅已观测提交 · 键盘请用仓库表">
									<FactoryScatter repos={scope} onSelect={drill} />
									<p className="text-center text-[11px] text-basalt-muted-foreground">
										横轴：窗口提交　纵轴：Open issue + PR（清单时点）
									</p>
								</FactoryPanel>
								<FactoryPanel title="工作流量账" hint="独立队列 · 不推断 Issue 与 PR 关联">
									<div className="factory-flow">
										<FlowRow
											label="Issues"
											values={[
												board.observed.issues ? board.aggregate.issueOpened : null,
												board.totals.openIssues,
												board.observed.issues ? board.aggregate.issueClosed : null,
											]}
											labels={["窗口创建", "当前开放", "窗口最后关闭"]}
										/>
										<FlowRow
											label="Pull requests"
											values={[
												board.observed.prs ? board.aggregate.prOpened : null,
												board.totals.openPrs,
												board.observed.prs ? board.aggregate.prMerged : null,
											]}
											labels={["窗口创建", "当前开放", "窗口合并"]}
										/>
									</div>
									<p className="mt-3 text-[11px] text-basalt-muted-foreground">
										PR 另有 {n(board.aggregate.prClosed)}{" "}
										个窗口内未合并关闭。创建队列与合并队列可能跨越窗口，箭头仅表达阶段。
									</p>
									<div className="mt-3 border-t border-basalt-border pt-3 text-xs">
										历史已关闭 Issue <strong>{n(board.totals.closedIssues)}</strong> · 历史已合并 PR{" "}
										<strong>{n(board.totals.mergedPrs)}</strong>
									</div>
								</FactoryPanel>
							</div>
							<div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
								<FactoryPanel title="需要检查的信号" hint="规则提示 · 不等于已证实阻塞">
									<div className="factory-signal-list">
										{board.anomalies.length ? (
											board.anomalies.map((a) => (
												<button
													type="button"
													key={`${a.repo}:${a.stream}`}
													onClick={() => drill(a.repo, a.stream)}
												>
													<span>{a.repo.split("/")[1]}</span>
													<span>{a.label}</span>
													<ArrowUpRight className="size-3.5" />
												</button>
											))
										) : (
											<p className="py-3 text-xs text-basalt-muted-foreground">
												已观察资源未触发长龄/CI 失败率规则。
											</p>
										)}
									</div>
									<p className="mt-3 text-[11px] text-basalt-muted-foreground">
										PR ≥7 天；Issue ≥14 天；CI 判定 ≥10 次且失败率 ≥20%。依赖告警完整覆盖{" "}
										{board.securityKnown}/{scope.length} 仓库；未覆盖的安全状态未知。
									</p>
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
												<button type="button" onClick={() => drill(e.source, "dependencies")}>
													{e.source.split("/")[1]}
												</button>
												<span className="factory-network-line" aria-hidden="true">
													→
												</span>
												<button type="button" onClick={() => drill(e.target, "dependencies")}>
													{e.target.split("/")[1]}
												</button>
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
							<FactoryPanel
								title={selected ? "仓库生产线" : "仓库生产线 · 按窗口提交量排序"}
								hint="每行是一条生产线，点击仓库或指标下钻"
							>
								<div className="factory-table-scroll">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>仓库 / 语言</TableHead>
												<TableHead>90 天节奏</TableHead>
												<TableHead className="text-right">提交</TableHead>
												<TableHead className="text-right">Open I / PR</TableHead>
												<TableHead className="text-right">合并 PR</TableHead>
												<TableHead className="text-right">CI 成功 / 判定</TableHead>
												<TableHead className="text-right">发布</TableHead>
												<TableHead>资源覆盖</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{ranking.rows.map((r) => (
												<TableRow key={r.id}>
													<TableCell>
														<button
															className="factory-repo-link"
															type="button"
															onClick={() => drill(r.name)}
														>
															{r.name.split("/")[1]}
														</button>
														<div className="text-[10px] text-basalt-muted-foreground">
															{r.language} {r.private ? "· private" : ""}
														</div>
													</TableCell>
													<TableCell>
														<span className="text-basalt-primary">
															{hasFactoryMeasurement(r, "commits") ? (
																<FactorySpark
																	values={board.days.map(
																		(d) => r.metrics.days[d.date]?.commits ?? 0,
																	)}
																	label={`${r.name} 每日提交`}
																/>
															) : (
																<span title="提交数据未采集">未采集</span>
															)}
														</span>
													</TableCell>
													<TableCell className="text-right">
														<button
															className="factory-number"
															type="button"
															onClick={() => drill(r.name, "commits")}
														>
															{factoryRepoCount(r, "commits")}
														</button>
													</TableCell>
													<TableCell className="text-right">
														<button
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "issues")}
														>
															{r.openIssues}
														</button>{" "}
														/{" "}
														<button
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "prs")}
														>
															{r.openPrs}
														</button>
													</TableCell>
													<TableCell className="text-right">
														<button
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "prs")}
														>
															{factoryRepoCount(r, "prs")}
														</button>
													</TableCell>
													<TableCell className="text-right">
														<button
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "actions")}
														>
															{r.coverage.actions.status === "complete"
																? `${r.metrics.ciSuccess} / ${r.metrics.ciSuccess + r.metrics.ciFailure}`
																: "—"}
														</button>
													</TableCell>
													<TableCell className="text-right">
														<button
															type="button"
															className="factory-number"
															onClick={() => drill(r.name, "releases")}
														>
															{factoryRepoCount(r, "releases")}
														</button>
													</TableCell>
													<TableCell>
														<div className="factory-coverage-dots">
															{FACTORY_STREAMS.map((k) => (
																<button
																	type="button"
																	key={k}
																	onClick={() => drill(r.name, k)}
																	className={`factory-coverage-${r.coverage[k].status}`}
																	title={`${STREAM_LABELS[k]}：${STATUS_LABELS[r.coverage[k].status]}`}
																	aria-label={`${r.name} ${STREAM_LABELS[k]}：${STATUS_LABELS[r.coverage[k].status]}`}
																>
																	{STREAM_CODES[k]}
																</button>
															))}
														</div>
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
								{ranking.pages > 1 ? (
									<div className="mt-3 flex items-center justify-end gap-2 text-xs">
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
									<fieldset className="factory-tabs">
										<legend className="sr-only">选择记录类型</legend>
										{FACTORY_STREAMS.map((k) => (
											<button
												type="button"
												key={k}
												aria-pressed={stream === k}
												onClick={() => {
													update("stream", k);
												}}
											>
												{STREAM_LABELS[k]}
											</button>
										))}
									</fieldset>
									<div className="factory-toolbar mt-3">
										<label>
											状态{" "}
											<select value={detailState} onChange={(e) => update("state", e.target.value)}>
												<option value="">全部状态</option>
												<option value="open">Open</option>
												<option value="merged">Merged</option>
												<option value="closed">Closed</option>
												<option value="success">CI success</option>
												<option value="failure">CI failure</option>
												<option value="cancelled">Cancelled</option>
											</select>
										</label>
										<label>
											{detailState === "merged"
												? "合并 UTC 日期"
												: detailState === "closed"
													? "关闭 UTC 日期"
													: "记录 UTC 日期"}{" "}
											<input
												type="date"
												value={detailDay}
												onChange={(e) => update("day", e.target.value)}
												className="rounded border border-basalt-border bg-basalt-background p-1"
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
											<p className="my-2 break-all text-[10px] text-basalt-muted-foreground">
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
																		<div className="max-w-96 truncate text-[10px] text-basalt-muted-foreground">
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
									<table>
										<caption className="sr-only">当前筛选内各日事件数，UTC</caption>
										<thead>
											<tr>
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
													<th key={h}>{h}</th>
												))}
											</tr>
										</thead>
										<tbody>
											{board.days.map((d) => (
												<tr
													key={d.date}
													className={day === d.date ? "factory-ledger-selected" : ""}
												>
													<th scope="row">{d.date}</th>
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
														<td
															key={`${d.date}-${["commit", "issue", "close", "pr", "merge", "reject", "ci", "fail", "release"][i]}`}
														>
															{n(value)}
														</td>
													))}
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</details>
						</>
					)}
					<details className="factory-methods">
						<summary>来源、口径与不确定性</summary>
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
							。每批至多 6 页，资源至多 5,000 条或 1.2
							MB；截断数据只表示观察子集。已完成资源在续传时复用；更新调查重新取样。
						</p>
						<p>
							topics 是 GitHub 作者设置的标签，可重叠，不能把标签分组总数相加。引用图只使用可定位的
							manifest/工作流证据；依赖告警覆盖 {board.securityKnown}/{scope.length}
							，未覆盖不代表无漏洞。
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
				</>
			) : null}
		</div>
	);
}
function Metric({
	label,
	value,
	note,
	children,
}: {
	label: string;
	value: string;
	note: string;
	children: React.ReactNode;
}) {
	return (
		<div className="factory-metric">
			<span>{label}</span>
			<strong>{value}</strong>
			<small>{note}</small>
			<div className="mt-2 text-basalt-primary">{children}</div>
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
			<div className="factory-flow-stages">
				{values.map((value, i) => (
					<div key={labels[i]}>
						<small>{labels[i]}</small>
						<strong>{value === null ? "—" : n(value)}</strong>
					</div>
				))}
			</div>
		</div>
	);
}
