// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import type { AnalysisReport, Resource } from "../../lib/analysis-contracts";
import { apiGet } from "../lib/api";
import { setActiveAccountId } from "../viewmodels/session";
import { AnalysisPage } from "./analysis";

vi.mock("../lib/api", () => ({ apiGet: vi.fn() }));

it("renders global and repository cards from the bounded server projection", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setActiveAccountId("a");
	const at = new Date().toISOString();
	const sources = ["account:issues", "repo:nocoo/app:issues"].map((resource) => ({
		resource,
		version: "v1",
		fetchedAt: at,
		truncated: false,
		unavailable: false,
	}));
	const items = [null, "nocoo/app"].flatMap((repository) =>
		[3, 2, 1].map((n): Resource => {
			const payload: AnalysisReport = {
				schemaVersion: 1,
				scope: repository ? "repo" : "global",
				repository,
				domain: "issues",
				verdict: "pass",
				summary: `${repository ?? "Portfolio"} report ${n}`,
				findings: [],
				actions: [],
				limitations: [],
				sources: [
					{
						resource: repository ? `repo:${repository}:issues` : "account:issues",
						version: "v1",
						fetchedAt: at,
						complete: true,
						stale: false,
					},
				],
				evidence: [],
				sourceVersion: "composite",
				observedAt: at,
				generatedAt: new Date(Date.parse(at) - (3 - n) * 1000).toISOString(),
				omitted: 0,
				judgment: { model: "external", choice: "routine" },
			};
			return {
				id: `${repository ? "repo" : "global"}-${n}`,
				account_id: "a",
				repository,
				type: "github-analysis",
				status: "completed",
				source_version: "composite",
				payload,
				revision: 1,
				created_at: at,
				updated_at: at,
			};
		}),
	);
	vi.mocked(apiGet).mockImplementation(async (path) => {
		if (path === "accounts") return { accounts: [{ id: "a", is_active: true }] };
		if (path === "agent/accounts/a/analysis/reports") return { account_id: "a", items };
		if (path === "agent/accounts/a/analysis/daily")
			return { account_id: "a", items: [], invalidCount: 0 };
		if (path.includes("/sources")) return { account_id: "a", sources, repositories: ["nocoo/app"] };
		if (path.includes("/records")) return { account_id: "a", items: [], nextCursor: null };
		throw new Error(`Unexpected request: ${path}`);
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		for (const [url, summary] of [
			["/analysis", "Portfolio report 3"],
			["/analysis?repo=nocoo%2Fapp", "nocoo/app report 3"],
		] as const) {
			await act(async () =>
				root.render(
					<MemoryRouter key={url} initialEntries={[url]}>
						<AnalysisPage />
					</MemoryRouter>,
				),
			);
			expect(container.textContent).toContain(summary);
			expect(container.textContent).not.toContain("report 2");
			expect(container.querySelector('[role="alert"]')).toBeNull();
		}
	} finally {
		await act(async () => root.unmount());
		container.remove();
		setActiveAccountId(null);
		vi.unstubAllGlobals();
	}
});
