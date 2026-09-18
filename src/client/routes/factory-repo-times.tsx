import { Button } from "@nocoo/basalt";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@nocoo/basalt/components/dialog";
import { Clock3, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FactoryRepo } from "../../lib/factory-types";
import { formatPreciseDate, formatTimeAgo } from "../lib/format";

export function FactoryRepoTimes({ repo }: { repo: FactoryRepo }) {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button
					size="sm"
					variant="ghost"
					className="whitespace-nowrap"
					aria-label={`查看 ${repo.name} 的数据时间`}
				>
					<Clock3 className="size-4" aria-hidden="true" />
					数据时间
				</Button>
			</DialogTrigger>
			<DialogContent size="lg" className="space-y-5">
				<DialogHeader>
					<div className="flex items-center justify-between gap-3">
						<DialogTitle className="text-xl">数据时间</DialogTitle>
						<DialogClose asChild>
							<Button size="icon" variant="ghost" aria-label="关闭数据时间">
								<X className="size-4" aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
					<DialogDescription className="break-all text-sm">{repo.name}</DialogDescription>
				</DialogHeader>
				<RepoTimeDetails repo={repo} />
			</DialogContent>
		</Dialog>
	);
}

function RepoTimeDetails({ repo }: { repo: FactoryRepo }) {
	const [now, setNow] = useState(Date.now);
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	// Dialog content mounts only while open; ticking never rerenders the table or charts.
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const records = [
		{
			label: "仓库信息更新",
			at: repo.metadataAt ?? repo.observation?.metadataAt,
			empty: "尚未记录仓库信息更新时间",
			description: "名称、语言及仓库概况的采集时间。",
		},
		{
			label: "活动数据更新",
			at: repo.observation?.refreshedAt,
			empty: "尚未采集活动数据",
			description:
				repo.observation?.source === "legacy"
					? "来自旧版采集记录，不代表刚刚刷新。"
					: "提交、PR、构建和发布等活动的采集时间。",
		},
	];
	return (
		<>
			<p className="text-xs text-basalt-muted-foreground">
				本地时区：{timeZone}。距今按本机时钟计算，每秒更新。
			</p>
			<dl className="divide-y divide-basalt-border">
				{records.map(({ label, at, empty, description }) => (
					<div key={label} className="space-y-2 py-4 first:pt-0">
						<dt className="text-base font-semibold">{label}</dt>
						<dd className="space-y-1">
							{at ? (
								<>
									<p role="timer" aria-label={`${label}距今`} className="text-base tabular-nums">
										{formatTimeAgo(at, now)}
									</p>
									<time dateTime={at} className="block text-sm tabular-nums">
										{formatPreciseDate(at, timeZone)}
									</time>
									<p className="text-xs text-basalt-muted-foreground">{description}</p>
								</>
							) : (
								<p className="text-sm text-basalt-muted-foreground">{empty}</p>
							)}
						</dd>
					</div>
				))}
				<div className="space-y-2 pt-4">
					<dt className="text-base font-semibold">统计范围</dt>
					<dd className="space-y-3">
						{repo.observation ? (
							<>
								<div className="grid gap-3 text-sm sm:grid-cols-2">
									{[
										["从", repo.observation.window.since],
										["到（不含）", repo.observation.window.until],
									].map(([label, at]) => (
										<div key={label} className="space-y-1">
											<p className="text-xs text-basalt-muted-foreground">{label}</p>
											<time dateTime={at} className="block tabular-nums">
												{formatPreciseDate(at, timeZone)}
											</time>
										</div>
									))}
								</div>
								<p className="text-xs text-basalt-muted-foreground">
									仅统计这段时间内的活动；日历日期按 UTC 汇总。
								</p>
							</>
						) : (
							<p className="text-sm text-basalt-muted-foreground">尚无可用的统计范围。</p>
						)}
					</dd>
				</div>
			</dl>
		</>
	);
}
