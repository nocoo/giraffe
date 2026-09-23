// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAiSettings, type PublicAiSettings } from "../../lib/ai-settings";
import { SettingsPage } from "../routes/settings";
import {
	deleteAiSettings,
	loadAiSettings,
	saveAiSettings,
	testAiSettings,
} from "../viewmodels/ai-settings";
import { AiSettings } from "./ai-settings";

vi.mock("../viewmodels/ai-settings", async (original) => ({
	...(await original<typeof import("../viewmodels/ai-settings")>()),
	loadAiSettings: vi.fn(),
	saveAiSettings: vi.fn(),
	testAiSettings: vi.fn(),
	deleteAiSettings: vi.fn(),
}));

vi.mock("./layout/select-field", () => ({
	SelectField: ({
		label,
		onValueChange,
		options,
	}: {
		label: string;
		onValueChange: (value: string) => void;
		options: { value: string; label: string }[];
	}) => (
		<div>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-label={`${label} ${option.label}`}
					onClick={() => onValueChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	),
}));

let container: HTMLDivElement;
let root: Root;

function node<T extends Element>(selector: string): T {
	const found = container.querySelector<T>(selector);
	if (!found) throw new Error(`Missing ${selector}`);
	return found;
}

async function change(id: string, value: string) {
	await act(async () => {
		const input = node<HTMLInputElement>(`#${id}`);
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function click(selector: string) {
	await act(async () => {
		node<HTMLButtonElement>(selector).click();
	});
}

async function submit(kind: string) {
	await act(async () => {
		node<HTMLFormElement>(`[data-testid="ai-${kind}-card"] form`).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
	});
}

async function render(
	settings: PublicAiSettings[] = [defaultAiSettings("summary"), defaultAiSettings("judgment")],
) {
	vi.mocked(loadAiSettings).mockResolvedValue(settings);
	await act(async () => {
		root.render(<AiSettings />);
	});
}

describe("AI settings cards", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		localStorage.clear();
	});
	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	});

	it("requires a model and key, clears submitted secrets, and leaves the other card usable", async () => {
		await render();
		expect(
			node<HTMLButtonElement>('[data-testid="ai-summary-card"] button[type="submit"]').disabled,
		).toBe(true);
		await submit("summary");
		expect(saveAiSettings).not.toHaveBeenCalled();
		await change("ai-summary-model", "summary-model");
		await change("ai-summary-url", "https://gateway.example/v1");
		await click('[aria-label="API 协议 Anthropic"]');
		await click('[aria-label="认证方式 Bearer token"]');
		await change("ai-summary-key", "fake-summary-key");
		let finish: ((value: PublicAiSettings) => void) | undefined;
		vi.mocked(saveAiSettings).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await submit("summary");
		expect(saveAiSettings).toHaveBeenCalledWith(
			"summary",
			expect.objectContaining({
				apiKey: "fake-summary-key",
				model: "summary-model",
				baseURL: "https://gateway.example/v1",
				sdkType: "anthropic",
				authType: "bearer",
			}),
		);
		expect(node<HTMLInputElement>("#ai-summary-key").value).toBe("");
		expect(
			node<HTMLFormElement>('[data-testid="ai-summary-card"] form').getAttribute("aria-busy"),
		).toBe("true");
		expect(
			node<HTMLFormElement>('[data-testid="ai-judgment-card"] form').getAttribute("aria-busy"),
		).toBe("false");
		await act(async () => {
			finish?.({
				...defaultAiSettings("summary"),
				model: "summary-model",
				baseURL: "https://gateway.example/v1",
				sdkType: "anthropic",
				authType: "bearer",
				hasApiKey: true,
			});
		});
		expect(container.textContent).toContain("已保存，下次刷新仓库数据时生效。");
		expect(node<HTMLInputElement>("#ai-summary-key").placeholder).toBe("留空保留已保存的 key");
		expect(localStorage.length).toBe(0);
	});

	it("tests without saving, clears failed keys, and retains saved settings after a failed request", async () => {
		await render([
			{ ...defaultAiSettings("summary"), model: "model", hasApiKey: true },
			defaultAiSettings("judgment"),
		]);
		vi.mocked(testAiSettings).mockResolvedValue(undefined);
		await click('[data-testid="ai-summary-test"]');
		expect(testAiSettings).toHaveBeenCalledWith("summary", expect.objectContaining({ apiKey: "" }));
		expect(container.textContent).toContain("连接成功。测试不会保存配置。");
		expect(saveAiSettings).not.toHaveBeenCalled();
		await change("ai-judgment-model", "jev-test");
		await change("ai-judgment-key", "fake-unsaved-key");
		vi.mocked(testAiSettings).mockRejectedValue(new Error("secret-upstream-body"));
		await click('[data-testid="ai-judgment-test"]');
		expect(node<HTMLInputElement>("#ai-judgment-key").value).toBe("");
		expect(container.textContent).toContain("请求失败，请检查服务地址、模型和 API key 后重试。");
		expect(container.textContent).not.toContain("secret-upstream-body");
		await change("ai-summary-model", "changed");
		vi.mocked(saveAiSettings).mockRejectedValue(new Error("save-failed"));
		await submit("summary");
		expect(node<HTMLInputElement>("#ai-summary-key").placeholder).toBe("留空保留已保存的 key");
		expect(localStorage.length).toBe(0);
	});

	it("renders loading and retries an unavailable settings request", async () => {
		let fail: ((error: Error) => void) | undefined;
		vi.mocked(loadAiSettings).mockImplementation(
			() =>
				new Promise((_, reject) => {
					fail = reject;
				}),
		);
		await act(async () => {
			root.render(<AiSettings />);
		});
		expect(container.textContent).toContain("加载 AI 配置…");
		await act(async () => {
			fail?.(new Error("failed"));
		});
		expect(container.textContent).toContain("AI 配置加载失败。");
		vi.mocked(loadAiSettings).mockResolvedValue([defaultAiSettings("judgment")]);
		await click("button");
		expect(container.textContent).toContain("JEV · 判断与归类");
	});

	it("can disable a provider and keeps the stored key if removal fails", async () => {
		await render([
			{ ...defaultAiSettings("summary"), model: "model", hasApiKey: true },
			defaultAiSettings("judgment"),
		]);
		vi.mocked(deleteAiSettings).mockRejectedValueOnce(new Error("failed"));
		await click('[data-testid="ai-summary-remove"]');
		expect(container.textContent).toContain("请求失败");
		expect(container.querySelector('[data-testid="ai-summary-remove"]')).not.toBeNull();
		vi.mocked(deleteAiSettings).mockResolvedValueOnce(undefined);
		await click('[data-testid="ai-summary-remove"]');
		expect(deleteAiSettings).toHaveBeenCalledWith("summary");
		expect(container.textContent).toContain("已停用并清除保存的 key。");
		expect(container.querySelector('[data-testid="ai-summary-remove"]')).toBeNull();
	});

	it("mounts both AI cards in the actual settings page alongside GitHub settings", async () => {
		vi.stubGlobal("fetch", async (url: string) => {
			if (url === "/api/accounts") return Response.json({ accounts: [] });
			if (url === "/api/me")
				return Response.json({ email: "settings@example.test", name: "Settings", avatar: null });
			throw new Error("unexpected request");
		});
		vi.mocked(loadAiSettings).mockResolvedValue([
			defaultAiSettings("summary"),
			defaultAiSettings("judgment"),
		]);
		await act(async () => {
			root.render(<SettingsPage />);
		});
		expect(container.textContent).toContain("连接 GitHub");
		expect(container.querySelector('[data-testid="ai-summary-card"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="ai-judgment-card"]')).not.toBeNull();
	});
});
