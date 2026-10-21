import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { makeRun, runProgress } from "../../lib/factory-run";
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
	const view = { ...run, progress: runProgress(run, snapshot.fetched_at), leaseUntil: null };
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
