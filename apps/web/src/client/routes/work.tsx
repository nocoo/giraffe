import { Button } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { useEffect, useMemo, useState } from "react";
import { useAnalysisRead } from "../components/layout/use-analysis-read";
import { formatPreciseDate } from "../lib/format";
import { loadWork, setWorkPaused, type WorkData, workBoard } from "../viewmodels/work";

export function WorkPage() {
	const [data, setData] = useState<WorkData | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [now, setNow] = useState(Date.now);
	useAnalysisRead(
		loadWork,
		(value) => {
			setData(value);
			setError("");
		},
		() => setError("Work 状态暂时不可用，保留上次记录。"),
		5000,
	);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 5000);
		return () => clearInterval(timer);
	}, []);
	const board = useMemo(() => (data ? workBoard(data, now) : null), [data, now]);
	async function pause() {
		if (!data || !board) return;
		setBusy(true);
		try {
			const control = await setWorkPaused(data.account_id, data.control, !board.desiredPaused);
			setData({ ...data, control });
		} catch {
			setError("控制保存失败，请重新读取后重试。");
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="space-y-4" data-testid="work-desk">
			<PageHeader
				title="Work"
				description="一个本机 cron · main 原子提交 · 独立审查 ≤20 轮 · 主机推送与三次 SHA 跟进"
				actions={
					<Button
						size="sm"
						variant="secondary"
						disabled={!board || busy}
						onClick={() => void pause()}
					>
						{busy ? "正在保存…" : board?.desiredPaused ? "恢复调度" : "暂停调度"}
					</Button>
				}
			/>
			<div className="flex flex-wrap gap-4 text-sm">
				<span>{board?.online ? "本机在线" : "本机离线"}</span>
				<span>{board?.cron?.expression ?? "未读取 cron"}</span>
				<span>{board?.cron?.timezone}</span>
				<span>
					{board?.pausePending ? "等待暂停确认" : board?.cron?.paused ? "已暂停" : "未暂停"}
				</span>
				<span>下一次：{formatPreciseDate(board?.cron?.nextRunAt ?? null)}</span>
			</div>
			{error || board?.errors.length ? (
				<p role="alert" className="text-sm text-basalt-destructive">
					{error || board?.errors.join("；")}
				</p>
			) : null}
			{!board?.jobs.length ? (
				<LayerCard>
					<LayerCard.Body>
						暂无 Work 周期。运行 bun run agent work；网页不能授权代码执行、合并或部署。
					</LayerCard.Body>
				</LayerCard>
			) : (
				board.jobs.map((job) => (
					<LayerCard key={job.id}>
						<LayerCard.Body>
							<div className="flex flex-wrap justify-between gap-3 text-sm">
								<strong>{job.status}</strong>
								<span>{job.occurrence}</span>
								<time>{formatPreciseDate(job.updatedAt)}</time>
							</div>
							<ol className="mt-3 space-y-2 break-words text-sm">
								{Object.entries(job.repositories).map(([repository, state]) => (
									<li key={repository} className="rounded-md border border-basalt-border p-3">
										<div className="flex flex-wrap justify-between gap-2">
											<strong>{repository}</strong>
											<span>{state.status}</span>
										</div>
										{state.dispositions?.map((item) => (
											<p key={item.task}>
												{item.task} · {item.outcome} {item.reason ?? ""}
											</p>
										))}
										{state.detailsOmitted ? (
											<p>
												详细原因已省略；任务结果：
												{state.tasks
													.map(
														(task, index) =>
															`${task}=${state.dispositionOutcomes?.[index] === "C" ? "committed" : state.dispositionOutcomes?.[index] === "N" ? "reviewed_no_change" : state.dispositionOutcomes?.[index] === "D" ? "deferred" : "pending"}`,
													)
													.join(", ")}
											</p>
										) : null}
										<div className="flex flex-wrap gap-x-4 gap-y-1">
											<span>任务 {state.tasks.join(", ")}</span>
											<span>
												Worker {state.worker ?? "—"} {state.workerModel ?? "执行模型"}
											</span>
											<span>
												Reviewer {state.reviewer ?? "—"} {state.reviewerModel ?? "独立审查模型"}
											</span>
											<span>轮次 {state.round}/20</span>
										</div>
										<p className="break-all">SHA {state.head ?? "未提交"}</p>
										{state.followup ? (
											<p>
												跟进 {state.followup.checks}/3 · {state.followup.outcome}
											</p>
										) : null}
										{state.findings.map((finding) => (
											<p key={finding} className="text-basalt-muted-foreground">
												{finding}
											</p>
										))}
									</li>
								))}
								{[...new Set(job.events)].map((event) => (
									<li key={event}>{event}</li>
								))}
							</ol>
						</LayerCard.Body>
					</LayerCard>
				))
			)}
		</div>
	);
}
