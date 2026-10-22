// @vitest-environment happy-dom
import { TooltipProvider } from "@nocoo/basalt";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activityFixture } from "../../../../../tests/e2e/activity-fixtures";
import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { setActiveAccountId } from "../viewmodels/session";
import { RepoCurrentActivity, TodayPage } from "./today";

vi.mock("../lib/api", () => ({ apiGet: vi.fn() }));

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	setActiveAccountId("ui-account");
	vi.mocked(apiGet).mockImplementation(async (resource) => {
		if (resource === "accounts") return { accounts: [{ id: "ui-account", is_active: true }] };
		if (resource.startsWith("projects/")) return null;
		return activityFixture();
	});
});

afterEach(() => {
	setActiveAccountId(null);
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

it("shows the actual unpublished API status as pending evidence, not an empty activity window", async () => {
	vi.mocked(apiGet).mockImplementation(async (resource) => {
		if (resource === "accounts") return { accounts: [{ id: "ui-account", is_active: true }] };
		throw new ApiError(409, "activity_unpublished", "No successful publication");
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<TodayPage />
				</TooltipProvider>,
			),
		);
		expect(container.textContent).toContain("等待活动发布");
		expect(container.textContent).not.toContain("窗口内没有记录");
		expect(container.querySelector('[data-testid="activity-window"]')).toBeNull();
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

it("retries an initial failed read without waiting for polling or issuing a write", async () => {
	let reads = 0;
	vi.mocked(apiGet).mockImplementation(async (resource) => {
		if (resource === "accounts") return { accounts: [{ id: "ui-account", is_active: true }] };
		if (resource.startsWith("projects/")) return null;
		reads += 1;
		if (reads === 1) throw new ApiError(503, "db_error", "safe error");
		return activityFixture();
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<TodayPage />
				</TooltipProvider>,
			),
		);
		expect(container.textContent).toContain("暂时无法读取当次活动");
		await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
		expect(reads).toBe(2);
		expect(container.querySelector('[data-testid="activity-window"]')).not.toBeNull();
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

it("does not show one repository's activity while navigating to another repository", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<RepoCurrentActivity repository="octocat/hello-world" />
				</TooltipProvider>,
			),
		);
		expect(apiGet).toHaveBeenCalledWith("activity?run=latest&repository=octocat%2Fhello-world");
		vi.mocked(apiGet).mockImplementation(async (resource) => {
			if (resource === "accounts") return { accounts: [{ id: "ui-account", is_active: true }] };
			return new Promise(() => undefined);
		});
		await act(async () =>
			root.render(
				<TooltipProvider>
					<RepoCurrentActivity repository="octocat/basalt" />
				</TooltipProvider>,
			),
		);
		expect(container.querySelector('[data-testid="activity-window"]')).toBeNull();
		expect(apiGet).toHaveBeenCalledWith("activity?run=latest&repository=octocat%2Fbasalt");
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
