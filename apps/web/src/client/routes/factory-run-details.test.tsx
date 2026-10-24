import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { makeRun, runProgress } from "../../lib/factory-run";
import { formatPreciseDate } from "../lib/format";
import { FactoryRunDetails } from "./factory-run-details";

it("renders limited work as fully processed with its own count and safe diagnostic", () => {
	const snapshot = factoryFixture();
	const run = makeRun(
		"r",
		snapshot.account_id,
		"nocoo",
		"key",
		"refresh",
		snapshot.repos,
		snapshot.fetched_at,
		[],
		[],
		{ scope: "selected" },
	);
	for (const step of run.steps) step.status = "success";
	Object.assign(run.steps.find((step) => step.kind === "dependencies") ?? {}, {
		status: "limited",
		error: "dependency_parse_unsupported",
	});
	run.status = "completed";
	const view = {
		...run,
		progress: runProgress(run, snapshot.fetched_at),
		leaseUntil: null,
		expectedFinishAt: null,
		expectedFinishAtReason: "terminal" as const,
	};
	const html = renderToStaticMarkup(
		<MemoryRouter>
			<FactoryRunDetails
				run={view}
				states={[]}
				now={Date.parse(snapshot.fetched_at)}
				onRetry={() => {}}
			/>
		</MemoryRouter>,
	);
	expect(html).toContain('data-status="limited"');
	expect(html).toContain("覆盖受限 1");
	expect(html).toContain("1 步覆盖受限");
	expect(html).toContain("依赖覆盖受限");
	expect(html).toContain(`value="${run.steps.length}"`);
	expect(html).not.toContain("undefined");
});

it.each(["completed", "failed", "partial", "cancelled"] as const)(
	"shows the actual finish and hides even a stale ETA for %s runs",
	(status) => {
		const finishedAt = "2026-10-23T21:27:34.000Z";
		const expectedFinishAt = "2026-10-23T21:30:44.000Z";
		const run = {
			...makeRun("0e256e3d", "account", "owner", "key", "catalog", [], "2026-10-23T21:00:44.000Z"),
			status,
			finishedAt,
		};
		const view = {
			...run,
			progress: { ...runProgress(run, finishedAt), etaSeconds: 190 },
			leaseUntil: null,
			expectedFinishAt,
			expectedFinishAtReason: null,
		};
		const html = renderToStaticMarkup(
			<MemoryRouter>
				<FactoryRunDetails run={view} states={[]} now={Date.parse(finishedAt)} onRetry={() => {}} />
			</MemoryRouter>,
		);
		expect(html).toContain(`结束 ${formatPreciseDate(finishedAt)}`);
		expect(html).not.toContain("预计");
		expect(html).not.toContain("正在估算剩余时间");
		expect(html).not.toContain(formatPreciseDate(expectedFinishAt));
	},
);
