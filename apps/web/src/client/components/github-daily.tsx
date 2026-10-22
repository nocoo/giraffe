import { Button } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { ArrowUpRight, Newspaper } from "lucide-react";
import { useState } from "react";
import type { GithubDailyHistory } from "../../lib/github-daily";
import { formatPreciseDate } from "../lib/format";
import { loadGithubDaily } from "../viewmodels/github-daily";
import { useAnalysisRead } from "./layout/use-analysis-read";

function keyedValues<Value>(values: Value[]) {
	const occurrences = new Map<string, number>();
	return values.map((value) => {
		const content = JSON.stringify(value);
		const occurrence = occurrences.get(content) ?? 0;
		occurrences.set(content, occurrence + 1);
		return { value, key: `${content}:${occurrence}` };
	});
}

export function GithubDailyCard() {
	const [attempt, setAttempt] = useState(0);
	return <DailyRead key={attempt} retry={() => setAttempt((value) => value + 1)} />;
}

function DailyRead({ retry }: { retry: () => void }) {
	const [data, setData] = useState<GithubDailyHistory | null>(null);
	const [failed, setFailed] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	useAnalysisRead(
		loadGithubDaily,
		(value) => {
			setData(value);
			setFailed(false);
		},
		() => {
			setData(null);
			setFailed(true);
		},
	);
	const row = data?.items.find((item) => item.id === selected) ?? data?.items[0];
	const report = row?.payload;
	return (
		<LayerCard data-testid="github-daily" className="min-w-0">
			<LayerCard.Body className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<h2 className="inline-flex items-center gap-2 text-base font-semibold">
						<Newspaper className="size-4" aria-hidden="true" />
						GitHub 日报
					</h2>
					{report ? (
						<a
							className="inline-flex items-center gap-1 text-sm"
							href={report.links.xray}
							target="_blank"
							rel="noopener noreferrer"
						>
							在 Xray 阅读
							<ArrowUpRight className="size-4" aria-hidden="true" />
						</a>
					) : null}
				</div>
				{failed ? (
					<div role="status" className="flex items-center gap-2 text-sm">
						<span>日报暂时不可用</span>
						<Button size="sm" variant="outline" onClick={retry}>
							重试
						</Button>
					</div>
				) : !data ? (
					<p role="status" className="text-sm text-basalt-muted-foreground">
						读取日报…
					</p>
				) : !report ? (
					<p className="text-sm text-basalt-muted-foreground">暂无 GitHub 日报</p>
				) : null}
				{data && data.invalidCount > 0 ? (
					<p role="alert" className="text-sm text-basalt-destructive">
						已隐藏 {data.invalidCount} 份无效或旧格式日报。
					</p>
				) : null}
				{data && report ? (
					<>
						<nav aria-label="最近七份日报" className="flex flex-wrap gap-1">
							{data.items.map((item, index) => (
								<Button
									key={item.id}
									size="sm"
									variant={item.id === row.id ? "secondary" : "ghost"}
									aria-pressed={item.id === row.id}
									onClick={() => setSelected(index === 0 ? null : item.id)}
								>
									{index === 0 ? "最新 · " : ""}
									{item.payload.date}
								</Button>
							))}
						</nav>
						<header className="space-y-1">
							<h3 className="break-words text-lg font-semibold">{report.headline}</h3>
							<p className="text-xs text-basalt-muted-foreground">
								北京日期 {report.date} · 生成于 {formatPreciseDate(report.generatedAt)}
							</p>
						</header>
						<div className="grid gap-3 sm:grid-cols-2">
							<div>
								<h4 className="text-sm font-medium">较昨日</h4>
								<p className="whitespace-pre-wrap break-words text-sm text-basalt-muted-foreground">
									{report.comparisons.vsYesterday || "未提供对比"}
								</p>
							</div>
							<div>
								<h4 className="text-sm font-medium">较 7 天前</h4>
								<p className="whitespace-pre-wrap break-words text-sm text-basalt-muted-foreground">
									{report.comparisons.vs7d || "未提供对比"}
								</p>
							</div>
						</div>
						{keyedValues(report.sections).map(({ value: section, key }) => (
							<section key={key} className="space-y-2 border-t border-basalt-border pt-3">
								<h4 className="break-words text-sm font-semibold">{section.title}</h4>
								<p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
									{section.markdown}
								</p>
								{section.items.length ? (
									<ul className="space-y-1 text-sm">
										{keyedValues(section.items).map(({ value: item, key }) => (
											<li key={key} className="break-words">
												<a
													href={item.url}
													target="_blank"
													rel="noopener noreferrer"
													className="underline underline-offset-2"
												>
													{item.repo ?? "全部仓库"} · {item.kind}
												</a>
												<span className="ml-2 text-basalt-muted-foreground">{item.severity}</span>
											</li>
										))}
									</ul>
								) : null}
							</section>
						))}
						<details className="space-y-2 text-xs text-basalt-muted-foreground">
							<summary className="cursor-pointer text-sm">来源与时间窗口</summary>
							<p className="break-all">
								{formatPreciseDate(report.window.since)} — {formatPreciseDate(report.window.until)}
							</p>
							<p className="break-all">
								刷新运行 {report.refreshRunId} · 修订 {row.revision}
							</p>
							{report.sources.length ? (
								keyedValues(report.sources).map(({ value: source, key }) => (
									<p key={key} className="break-all">
										{source.resource} · {source.version ?? "版本未知"} ·{" "}
										{formatPreciseDate(source.fetchedAt)} ·{" "}
										{source.complete ? "覆盖完整" : "覆盖不完整"}
										{source.stale ? " · 已过期" : ""}
									</p>
								))
							) : (
								<p>未附来源</p>
							)}
						</details>
					</>
				) : null}
			</LayerCard.Body>
		</LayerCard>
	);
}
