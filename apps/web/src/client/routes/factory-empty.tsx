import { SectionRule } from "@nocoo/basalt/components/section-rule";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { Activity, Boxes } from "lucide-react";
import { IconLabel } from "../components/layout/icon-label";
import { Kpi, KpiRow } from "../components/layout/kpi";
import { FactoryPanel } from "./factory-charts";

export function FactoryEmpty() {
	return (
		<div className="factory-board">
			<FactoryPanel title="暂无已保存的快照" hint="使用当前 GitHub 账号">
				<p className="text-sm text-basalt-muted-foreground">
					可从顶部发起统一刷新，先读取账号信息，再串行刷新星标与新发现的仓库。缺少数据不代表没有活动。
				</p>
			</FactoryPanel>
			<section className="factory-period" aria-label="区间变化">
				<header>区间变化 · 暂无观测窗口</header>
				<dl>
					{["提交", "PR 合并 / 新开", "Issue 关闭 / 新开 · 净增变化", "CI 成功率", "发布"].map(
						(label) => (
							<div key={label}>
								<dt>{label}</dt>
								<dd>
									<strong>—</strong>
								</dd>
							</div>
						),
					)}
				</dl>
			</section>
			<section className="factory-section" aria-labelledby="factory-change-title">
				<SectionRule
					id="factory-change-title"
					title={<IconLabel icon={Activity}>变化 · 暂无观测窗口</IconLabel>}
				/>
				{[
					["提交产出与覆盖面", "交付吞吐"],
					["PR 流量与存量", "Issue 流量与存量"],
				].map((titles) => (
					<div key={titles[0]} className="factory-chart-grid grid gap-3 xl:grid-cols-2">
						{titles.map((title) => (
							<FactoryPanel key={title} title={title} hint="暂无已保存的观测窗口。">
								<p className="factory-chart-empty">暂无已保存数据</p>
							</FactoryPanel>
						))}
					</div>
				))}
				<FactoryPanel title="仓库变化矩阵" hint="暂无已保存的仓库变化记录。">
					<p className="py-4 text-sm text-basalt-muted-foreground">暂无已保存数据</p>
				</FactoryPanel>
			</section>
			<section className="factory-section" aria-labelledby="factory-stock-title">
				<SectionRule
					id="factory-stock-title"
					title={<IconLabel icon={Boxes}>存量 · 我名下全部仓库</IconLabel>}
				/>
				<KpiRow>
					{["仓库", "Open Issue / PR", "历史提交", "已合并 PR · 历史", "CI 观测成功率"].map(
						(label) => (
							<Kpi key={label} label={label} value="—" subtitle="暂无已保存数据" />
						),
					)}
				</KpiRow>
				<div className="factory-chart-grid grid gap-3 xl:grid-cols-[1.15fr_1fr]">
					{["提交日历", "积压任务"].map((title) => (
						<FactoryPanel key={title} title={title} hint="暂无已保存快照。">
							<p className="factory-chart-empty">暂无已保存数据</p>
						</FactoryPanel>
					))}
				</div>
				<div className="factory-chart-grid grid gap-3 xl:grid-cols-3">
					{["仓库规模地图", "提交与待办", "工作流量账"].map((title) => (
						<FactoryPanel key={title} title={title} hint="暂无已保存快照。">
							<p className="factory-chart-empty">暂无已保存数据</p>
						</FactoryPanel>
					))}
				</div>
				<div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
					{["需要检查的信号", "依赖与维护"].map((title) => (
						<FactoryPanel key={title} title={title} hint="缺少数据不代表没有问题。">
							<p className="py-4 text-sm text-basalt-muted-foreground">暂无已保存数据</p>
						</FactoryPanel>
					))}
				</div>
			</section>
			<FactoryPanel title="仓库生产线 · 按窗口提交量排序" hint="暂无已保存的仓库观测记录。" flush>
				<div className="factory-table-scroll">
					<Table aria-label="仓库生产线">
						<TableHeader>
							<TableRow>
								{[
									"仓库 / 语言",
									"观测窗口节奏",
									"提交",
									"Open I / PR",
									"合并 PR",
									"CI 成功 / 判定",
									"发布",
									"资源覆盖",
									"时间",
								].map((label) => (
									<TableHead key={label}>{label}</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							<TableRow>
								<TableCell colSpan={9} className="text-center text-basalt-muted-foreground">
									暂无已保存的仓库观测记录
								</TableCell>
							</TableRow>
						</TableBody>
					</Table>
				</div>
			</FactoryPanel>
			<details className="factory-methods" id="factory-ledger">
				<summary>每日账本 · 可访问的图表数据与趋势核对</summary>
				<p>暂无已保存的每日记录。</p>
			</details>
			<details className="factory-methods">
				<summary>来源、口径与不确定性</summary>
				<p>尚未保存来源、覆盖与观测窗口；缺少数据不代表零。</p>
			</details>
		</div>
	);
}
