// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dailyReport } from "../../../../../tests/fixtures/daily-report";
import { loadGithubDaily } from "../viewmodels/github-daily";
import { GithubDailyCard } from "./github-daily";

vi.mock("../viewmodels/github-daily", () => ({ loadGithubDaily: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

it("R8 daily renders escaped sections, comparisons, evidence and a safe Xray link alongside invalid notices", async () => {
	vi.mocked(loadGithubDaily).mockResolvedValue({
		account_id: "a",
		items: [dailyReport()],
		invalidCount: 2,
	});
	await act(async () => root.render(<GithubDailyCard />));
	expect(container.textContent).toContain("Daily delivery review");
	expect(container.textContent).toContain("<script>alert(1)</script>");
	expect(container.querySelector("script")).toBeNull();
	expect(container.textContent).toContain("One fewer failure");
	expect(container.textContent).toContain("Delivery remains stable");
	expect(container.textContent).toContain("2 份无效或旧格式日报");
	const link = container.querySelector('a[href="https://xray.example/daily"]');
	expect(link?.getAttribute("target")).toBe("_blank");
	expect(link?.getAttribute("rel")).toContain("noopener");
	expect(container.textContent).toContain("owner/app");
	expect(container.textContent).toContain("account:ci");
});

it("R8 daily starts at newest and browses the seven returned reports without mixing their content", async () => {
	const items = Array.from({ length: 7 }, (_, index) =>
		dailyReport(`2026-10-${22 - index}`, `Report ${index}`),
	);
	vi.mocked(loadGithubDaily).mockResolvedValue({ account_id: "a", items, invalidCount: 0 });
	await act(async () => root.render(<GithubDailyCard />));
	expect(container.textContent).toContain("Report 0");
	expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(7);
	await act(async () =>
		Array.from(container.querySelectorAll("button"))
			.find((button) => button.textContent === "2026-10-16")
			?.click(),
	);
	expect(container.textContent).toContain("Report 6");
	expect(container.textContent).not.toContain("Report 0");
	await act(async () =>
		container.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')?.click(),
	);
	expect(container.textContent).toContain("Report 0");
});

it("R8 daily supports repeated sections and quiet-day empty evidence without unstable keys", async () => {
	const item = dailyReport();
	item.payload.sections = [
		{ title: "Quiet day", markdown: "No additional evidence", items: [] },
		{ title: "Quiet day", markdown: "No additional evidence", items: [] },
	];
	item.payload.sources = [];
	item.payload.comparisons = { vsYesterday: "", vs7d: "" };
	vi.mocked(loadGithubDaily).mockResolvedValue({ account_id: "a", items: [item], invalidCount: 0 });
	const errors = vi.spyOn(console, "error");
	try {
		await act(async () => root.render(<GithubDailyCard />));
		expect(container.querySelectorAll("section")).toHaveLength(2);
		expect(container.textContent).toContain("未附来源");
		expect(container.textContent).toContain("未提供对比");
		expect(errors).not.toHaveBeenCalled();
	} finally {
		errors.mockRestore();
	}
});

it("R8 daily isolates load failures and retries into an empty result", async () => {
	vi.mocked(loadGithubDaily)
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValueOnce({ account_id: "a", items: [], invalidCount: 0 });
	await act(async () => root.render(<GithubDailyCard />));
	expect(container.textContent).toContain("日报暂时不可用");
	await act(async () => container.querySelector("button")?.click());
	expect(container.textContent).toContain("暂无 GitHub 日报");
});
