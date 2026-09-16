import { Button } from "@nocoo/basalt";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FactoryRunResponse, RunSelection } from "../../lib/factory-run";
import type { FactorySnapshot } from "../../lib/factory-types";
import { factoryError, formatUtc } from "../viewmodels/factory";
import {
	controlFactoryRun,
	createRunPolling,
	loadFactoryRuns,
	RUN_LABELS,
	runRepositoryRows,
	STEP_LABELS,
	STEP_STATUS,
	secondsUntil,
	startFactoryRun,
} from "../viewmodels/factory-runs";
import { FactoryPanel } from "./factory-charts";

const duration = (seconds: number) =>
	seconds >= 3600
		? `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`
		: seconds >= 60
			? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
			: `${seconds}s`;
export function FactoryRuns({
	snapshot,
	onPublished,
	filter,
}: {
	snapshot: FactorySnapshot | null;
	onPublished: () => Promise<void>;
	filter: { language: string; topic: string; query: string; repo: string };
}) {
	const [data, setData] = useState<FactoryRunResponse | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [scope, setScope] = useState<RunSelection["scope"]>("selected");
	const [selected, setSelected] = useState<string[]>([]);
	const [priority, setPriority] = useState<Record<string, number>>({});
	const [historyId, setHistoryId] = useState("");
	const historyRef = useRef("");
	const [now, setNow] = useState(Date.now());
	const offset = useRef(0);
	const publication = useRef<string | null | undefined>(undefined);
	const poll = useRef<ReturnType<typeof createRunPolling> | null>(null);
	const onPublishedRef = useRef(onPublished);
	onPublishedRef.current = onPublished;
	const intent = useRef<{ signature: string; key: string } | null>(null);
	useEffect(() => {
		poll.current = createRunPolling({
			load: () => loadFactoryRuns(historyRef.current),
			hidden: () => document.hidden,
			onError: (err) => setError(factoryError(err)),
			onData: (state) => {
				setData(state);

				offset.current = Date.parse(state.serverNow) - Date.now();
				setNow(Date.now() + offset.current);
				setError("");
				if (state.publication && publication.current !== state.publication)
					void onPublishedRef.current().catch((err) => setError(factoryError(err)));
				publication.current = state.publication;
			},
		});
		const tick = setInterval(() => setNow(Date.now() + offset.current), 1000);
		return () => {
			poll.current?.stop();
			clearInterval(tick);
		};
	}, []);
	const catalog = data?.catalog ?? snapshot?.repos ?? [];
	const options = useMemo(
		() =>
			catalog.filter(
				(r) =>
					(!filter.repo || r.name === filter.repo) &&
					(!filter.language || r.language === filter.language) &&
					(!filter.topic || r.topics.includes(filter.topic)) &&
					(!filter.query ||
						`${r.name} ${r.description ?? ""}`.toLowerCase().includes(filter.query.toLowerCase())),
			),
		[catalog, filter],
	);
	const current = data?.current ?? null;
	const viewed = historyId
		? (data?.history.find((r) => r.id === historyId) ?? current)
		: (current ?? data?.history[0] ?? null);
	const cooldown = secondsUntil(data?.nextAllowedAt ?? null, now);
	const rows = runRepositoryRows(viewed, data?.repositories ?? []);
	async function start(mode: "catalog" | "refresh") {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const names = [
				...(scope === "selected"
					? selected
					: (scope === "filter" ? options : catalog).map((r) => r.name)),
			].sort((a, b) => (priority[a] ?? 100) - (priority[b] ?? 100));
			const input = {
				mode,
				scope: scope === "filter" ? ("selected" as const) : scope,
				repos: names,
			};
			const signature = JSON.stringify(input);
			if (intent.current?.signature !== signature)
				intent.current = { signature, key: crypto.randomUUID() };
			await startFactoryRun(input, intent.current.key);
			intent.current = null;
			setHistoryId("");
			historyRef.current = "";
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
		<FactoryPanel title="刷新控制台" hint="服务端持久任务 · 离开页面后继续执行">
			{!data && !error ? (
				<p role="status" className="p-3 text-sm">
					正在恢复服务端运行状态…
				</p>
			) : null}
			{error ? (
				<p role="alert" className="factory-notice factory-warning">
					{error}{" "}
					<button type="button" onClick={() => void poll.current?.refresh()}>
						重读任务状态
					</button>
				</p>
			) : null}
			<div className="factory-run-meta">
				<span>
					最近全局快照 <strong>{formatUtc(snapshot?.fetched_at ?? null)}</strong>
				</span>
				<span>
					{cooldown ? `启动冷却 ${duration(cooldown)}` : "可创建刷新"} · 下次允许{" "}
					{data?.nextAllowedAt ? formatUtc(data.nextAllowedAt) : "现在"}
				</span>
				<span>
					清单 {catalog.length} 仓库 · {data?.catalogComplete ? "完整" : "尚未发现完整清单"}
				</span>
			</div>
			{current ? (
				<div className="factory-run-controls">
					<strong>{RUN_LABELS[current.status]}</strong>
					<code title={current.id}>{current.id.slice(0, 8)}</code>
					<Button
						size="sm"
						variant="secondary"
						disabled={busy}
						onClick={() => void control(current.status === "paused" ? "resume" : "pause")}
					>
						{current.status === "paused" ? "续跑" : "暂停"}
					</Button>
					<Button size="sm" variant="ghost" disabled={busy} onClick={() => void control("cancel")}>
						取消剩余任务
					</Button>
					<span className="text-xs">已提交的仓库数据保留；本次范围和顺序已冻结。</span>
				</div>
			) : (
				<details className="factory-run-plan" open={!catalog.length}>
					<summary>计划下一次刷新 · 默认仅刷新手动选择的仓库</summary>
					<div className="factory-run-controls">
						<label>
							范围{" "}
							<select
								aria-label="刷新范围"
								value={scope}
								onChange={(e) => setScope(e.target.value as RunSelection["scope"])}
							>
								<option value="selected">手动选择</option>
								<option value="filter">当前筛选 / 仓库群（{options.length}）</option>
								<option value="all" disabled={!data?.catalogComplete}>
									全部仓库（{catalog.length}）
								</option>
								<option value="stale" disabled={!data?.catalogComplete}>
									过期 / 覆盖不足（24h）
								</option>
								<option value="failed" disabled={!data?.catalogComplete}>
									仅上次失败
								</option>
							</select>
						</label>
						<Button
							size="sm"
							disabled={busy || !data || cooldown > 0 || (scope === "selected" && !selected.length)}
							onClick={() => void start("refresh")}
						>
							创建刷新计划
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={busy || !data || cooldown > 0}
							onClick={() => void start("catalog")}
						>
							重新发现仓库 / 恢复旧资源
						</Button>
					</div>
					<p className="px-3 text-xs text-basalt-muted-foreground">
						优先级数字越小越先执行，同优先级保持选择顺序。发现清单只读取仓库元数据并恢复已存资源，不采集全仓活动。每仓库刷新后冷却
						15 分钟。
					</p>
					<fieldset className="factory-run-select">
						<legend className="sr-only">选择仓库及优先级</legend>
						{options.map((repo) => {
							const state = data?.repositories.find((r) => r.repo === repo.name);
							return (
								<div key={repo.id} className="factory-run-select-row">
									<label>
										<input
											type="checkbox"
											checked={selected.includes(repo.name)}
											onChange={(e) =>
												setSelected((old) =>
													e.target.checked
														? [...old, repo.name]
														: old.filter((name) => name !== repo.name),
												)
											}
										/>
										<span>{repo.name}</span>
									</label>
									<label className="factory-priority">
										优先级{" "}
										<input
											type="number"
											min="1"
											max="999"
											aria-label={`${repo.name} 优先级`}
											value={priority[repo.name] ?? 100}
											onChange={(e) =>
												setPriority((old) => ({
													...old,
													[repo.name]: Math.max(1, Math.min(999, Number(e.target.value) || 100)),
												}))
											}
										/>
									</label>
									<span title={formatUtc(state?.refreshedAt ?? null)}>
										{state?.status ?? "无刷新记录"} ·{" "}
										{state?.refreshedAt ? formatUtc(state.refreshedAt) : "无成功快照"}
										{secondsUntil(state?.nextAllowedAt ?? null, now) > 0
											? ` · 冷却 ${duration(secondsUntil(state?.nextAllowedAt ?? null, now))}`
											: ""}
									</span>
								</div>
							);
						})}
					</fieldset>
				</details>
			)}
			<div className="factory-run-controls">
				<label>
					运行记录{" "}
					<select
						aria-label="运行记录"
						value={historyId}
						onChange={(e) => {
							historyRef.current = e.target.value;
							setHistoryId(e.target.value);
							void poll.current?.refresh();
						}}
					>
						<option value="">{current ? "当前 run" : "最近一次 run"}</option>
						{data?.history.map((r) => (
							<option key={r.id} value={r.id}>
								{r.startedAt.slice(0, 19).replace("T", " ")} UTC · {RUN_LABELS[r.status]} ·{" "}
								{r.repos.length} 仓库
							</option>
						))}
					</select>
				</label>
				<button type="button" onClick={() => void poll.current?.refresh()}>
					检查服务端状态
				</button>
			</div>
			{viewed ? (
				<div className="factory-run-thread">
					<div className="factory-run-progress-label" role="status" aria-live="polite">
						<strong>
							{viewed.progress.completed} / {viewed.progress.total} 步
						</strong>
						<span>
							成功 {viewed.progress.success} · 失败 / 覆盖不足 {viewed.progress.failed} · 跳过{" "}
							{viewed.progress.skipped}
						</span>
						<span>
							{RUN_LABELS[viewed.status]} · {viewed.requests} 次 GitHub 请求
						</span>
					</div>
					<progress
						max={viewed.progress.total}
						value={viewed.progress.completed}
						aria-label="已完成逻辑步骤"
						className="factory-run-progress"
					/>
					<div className="factory-run-meta">
						<span>
							当前{" "}
							{viewed.progress.current
								? `${viewed.progress.current.repo ?? "全局"} / ${STEP_LABELS[viewed.progress.current.kind]}`
								: "已结束"}
						</span>
						<span>开始 {formatUtc(viewed.startedAt)}</span>
						<span>心跳 {formatUtc(viewed.updatedAt)}</span>
						<span>
							估计剩余{" "}
							{viewed.finishedAt
								? "已结束"
								: viewed.progress.etaSeconds === null
									? "未知"
									: `约 ${duration(viewed.progress.etaSeconds)}（按已完成步骤耗时估算）`}
						</span>
					</div>
					{viewed.status === "running" && secondsUntil(viewed.nextAttemptAt, now) > 0 ? (
						<p role="status" className="factory-notice">
							等待重试 / GitHub 配额 · {duration(secondsUntil(viewed.nextAttemptAt, now))} ·{" "}
							{formatUtc(viewed.nextAttemptAt)}
						</p>
					) : null}
					{viewed.status === "running" &&
					viewed.leaseUntil &&
					secondsUntil(viewed.leaseUntil, now) === 0 ? (
						<p role="status" className="factory-notice">
							执行租约已过期，服务端会在下一次恢复扫描接管。
						</p>
					) : null}
					<ol className="factory-run-stages">
						{viewed.steps
							.filter((s) => !s.repo)
							.map((s) => (
								<li key={s.kind} data-status={s.status}>
									<strong>{STEP_LABELS[s.kind]}</strong>
									<span>
										{STEP_STATUS[s.status]} · {s.pages} 页{s.error ? ` · ${s.error}` : ""}
									</span>
								</li>
							))}
					</ol>
					<div className="factory-run-queue">
						{rows.map((row, index) => (
							<details key={row.repo} className="factory-run-row" data-status={row.status}>
								<summary>
									<span>
										{index + 1}. {row.repo}
									</span>
									<span>{STEP_STATUS[row.status]}</span>
									<span>
										{row.completed}/{row.total} 步 · {row.pages} 页 ·{" "}
										{duration(Math.ceil(row.durationMs / 1000))}
									</span>
									<span>
										最近成功 {formatUtc(row.state?.refreshedAt ?? null)} · 覆盖{" "}
										{row.state?.coverage ?? "—"}/7
									</span>
								</summary>
								<div className="factory-run-meta">
									<span>
										当前成功快照窗口{" "}
										{row.state?.observation
											? `${row.state.observation.window.since} → ${row.state.observation.window.until}`
											: "未知"}{" "}
										· {row.state?.observation?.source === "legacy" ? "旧资源恢复" : "GitHub 采集"}
									</span>
									<span>元数据观测 {formatUtc(row.state?.observation?.metadataAt ?? null)}</span>
									<span>下次可刷新 {formatUtc(row.state?.nextAllowedAt ?? null)}</span>
									<span>
										重试{" "}
										{row.state?.retries ??
											row.steps.reduce((n, s) => n + Math.max(0, s.attempts - 1), 0)}{" "}
										· {row.state?.error ?? "—"}
									</span>
								</div>
								<ol className="factory-run-stages">
									{row.steps.map((step) => (
										<li key={step.kind} data-status={step.status}>
											<strong>{STEP_LABELS[step.kind]}</strong>
											<span>
												{STEP_STATUS[step.status]} · {step.pages} 页 ·{" "}
												{duration(Math.ceil(step.durationMs / 1000))}
											</span>
											{step.error ? <span>{step.error}</span> : null}
										</li>
									))}
								</ol>
							</details>
						))}
					</div>
					<p className="px-3 py-2 text-xs text-basalt-muted-foreground">
						分母为启动时冻结的逻辑步骤；GitHub 分页数不预估。完整刷新为 9 × 仓库数 + 2
						步。暂停、重载、失败均保留上次发布数据；所有时间为 UTC。
					</p>
				</div>
			) : data ? (
				<p className="p-3 text-sm text-basalt-muted-foreground">
					暂无持久运行记录。已有工厂快照仍可浏览。
				</p>
			) : null}
		</FactoryPanel>
	);
}
