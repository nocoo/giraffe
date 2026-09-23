import { Button } from "@nocoo/basalt";
import { formatCount } from "../../lib/format";

export type RankRow = {
	name: string;
	value: number;
	label?: string;
	color?: string;
	note?: string;
};

/**
 * Horizontal ranked bars: label, bar scaled to the largest row, count. Clicking a row filters by it;
 * clicking the active row clears the filter.
 */
export function RankBars({
	rows,
	max,
	label,
	active = "",
	onSelect,
	color = "var(--color-basalt-primary)",
}: {
	rows: RankRow[];
	max: number;
	label: string;
	active?: string;
	onSelect?: (name: string) => void;
	color?: string;
}) {
	if (!rows.length) return <p className="giraffe-rank-empty">暂无数据</p>;
	return (
		<ol className="giraffe-rank" aria-label={label}>
			{rows.map((row, i) => {
				const body = (
					<>
						<span className="giraffe-rank-name" title={row.label ?? row.name}>
							{row.label ?? row.name}
						</span>
						<span className="giraffe-rank-track" aria-hidden="true">
							<span
								style={{
									width: `${Math.min(100, Math.max(2, (row.value / max) * 100))}%`,
									background: row.color ?? color,
									animationDelay: `${i * 30}ms`,
								}}
							/>
						</span>
						<span className="giraffe-rank-value">
							{formatCount(row.value)}
							{row.note ? <small>{row.note}</small> : null}
						</span>
					</>
				);
				return (
					<li key={row.name} data-active={active === row.name || undefined}>
						{onSelect && row.name !== "其他" ? (
							<Button
								type="button"
								variant="ghost"
								className="giraffe-rank-row"
								aria-pressed={active === row.name}
								onClick={() => onSelect(active === row.name ? "" : row.name)}
							>
								{body}
							</Button>
						) : (
							<div className="giraffe-rank-row">{body}</div>
						)}
					</li>
				);
			})}
		</ol>
	);
}

/** Stacked share bar with a legend; each segment is a category of one whole. */
export function ShareBar({
	parts,
	label,
	legend = true,
}: {
	parts: { key: string; label: string; value: number; color: string }[];
	label: string;
	legend?: boolean;
}) {
	const total = parts.reduce((n, p) => n + p.value, 0);
	return (
		<div className="giraffe-share">
			<div
				className="giraffe-share-bar"
				role="img"
				aria-label={`${label}：${parts.map((p) => `${p.label} ${p.value}`).join("，")}`}
			>
				{parts.map((p) =>
					p.value ? (
						<span
							key={p.key}
							style={{ flexGrow: p.value, background: p.color }}
							title={`${p.label} ${formatCount(p.value)}`}
						/>
					) : null,
				)}
				{total ? null : <span style={{ flexGrow: 1 }} />}
			</div>
			{legend ? (
				<dl className="giraffe-share-legend">
					{parts.map((p) => (
						<div key={p.key}>
							<dt>
								<i style={{ background: p.color }} aria-hidden="true" />
								{p.label}
							</dt>
							<dd>
								{formatCount(p.value)}
								{total ? <small>{Math.round((p.value / total) * 100)}%</small> : null}
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</div>
	);
}
