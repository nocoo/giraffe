// @vitest-environment happy-dom
import { TooltipProvider } from "@nocoo/basalt";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicAccount } from "../viewmodels/accounts";
import {
	type ApiTokenRow,
	createToken,
	listTokens,
	revokeToken,
	updateToken,
} from "../viewmodels/api-tokens";
import { ApiTokens } from "./api-tokens";

vi.mock("../viewmodels/api-tokens", async (original) => ({
	...(await original<object>()),
	createToken: vi.fn(),
	listTokens: vi.fn(),
	revokeToken: vi.fn(),
	updateToken: vi.fn(),
}));

const account: PublicAccount = {
	id: "a",
	login: "owner",
	avatar_url: "",
	token_last4: "test",
	scopes: "repo",
	capabilities: {},
	is_active: true,
};
const row: ApiTokenRow = {
	id: "t",
	account_id: "a",
	label: "External Bot",
	scopes: ["observations:read", "agent:read", "agent:write"],
	creator: "owner",
	created_at: "2026-10-01T00:00:00Z",
	expires_at: "2026-11-01T00:00:00Z",
	revoked_at: null,
	last_used_at: null,
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.mocked(listTokens).mockResolvedValue({ account_id: "a", items: [] });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.resetAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function setInputValue(input: HTMLInputElement | null, value: string) {
	if (!input) throw new Error("Missing input");
	const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	if (!set) throw new Error("Missing value setter");
	set.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(label: string) {
	const element = Array.from(container.querySelectorAll("button")).find(
		(item) => item.textContent === label,
	);
	if (!element) throw new Error(`Missing button: ${label}`);
	return element;
}

it("keeps machine token settings and names the app-write refresh permission", async () => {
	await act(async () =>
		root.render(
			<TooltipProvider>
				<ApiTokens accounts={[]} />
			</TooltipProvider>,
		),
	);
	expect(container.textContent).toContain("外部 Bot API 令牌");
	expect(container.textContent).toContain("创建令牌");
	expect(container.textContent).toContain("管理现有令牌");
	expect(container.querySelector<HTMLInputElement>("#new-token-label")?.value).toBe("External Bot");
	expect(container.textContent).not.toMatch(/本地 Agent|CLI|PKCE/);
	expect(container.textContent).toContain("原文只显示一次");
	expect(container.textContent).toContain("撤销立即生效");
	expect(container.textContent).toContain("修改应用配置");
	expect(container.textContent).toContain("发起刷新");
	expect(container.textContent).not.toContain("令牌仅绑定所选账号");
	const info = container.querySelector<HTMLButtonElement>('[aria-label="外部 Bot API 令牌说明"]');
	expect(info).not.toBeNull();
	await act(async () => info?.click());
	expect(document.body.textContent).toContain("令牌仅绑定所选账号");
	expect(button("创建令牌").disabled).toBe(true);
	expect(listTokens).not.toHaveBeenCalled();
});

it("creates, narrows and revokes an account-bound token while keeping the raw token ephemeral", async () => {
	const storageWrite = vi.spyOn(Storage.prototype, "setItem");
	vi.mocked(createToken).mockResolvedValue({ ...row, token: "giraffe_test_once" });
	await act(async () =>
		root.render(
			<TooltipProvider>
				<ApiTokens accounts={[account]} />
			</TooltipProvider>,
		),
	);
	expect(listTokens).toHaveBeenCalledWith("a");
	vi.mocked(listTokens).mockResolvedValue({ account_id: "a", items: [row] });
	setInputValue(container.querySelector<HTMLInputElement>("#new-token-label"), "Ops Bot");
	await act(async () =>
		container
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
	);
	expect(createToken).toHaveBeenCalledWith(
		"a",
		"Ops Bot",
		["observations:read", "agent:read", "agent:write"],
		30,
	);
	expect(
		container.querySelector<HTMLInputElement>('[aria-label="新 API 令牌（仅显示一次）"]')?.value,
	).toBe("giraffe_test_once");
	await act(async () => button("已保存，隐藏令牌").click());
	expect(container.querySelector('[aria-label="新 API 令牌（仅显示一次）"]')).toBeNull();
	const checkbox = container.querySelector<HTMLButtonElement>('[id="t-agent:write"]');
	await act(async () => checkbox?.click());
	setInputValue(
		container.querySelector<HTMLInputElement>('[aria-label="External Bot 标签"]'),
		"Renamed",
	);
	await act(async () => button("保存标签与权限").click());
	expect(updateToken).toHaveBeenCalledWith("a", "t", "Renamed", [
		"observations:read",
		"agent:read",
	]);
	vi.mocked(listTokens).mockResolvedValue({
		account_id: "a",
		items: [{ ...row, revoked_at: "2026-10-02T00:00:00Z" }],
	});
	await act(async () => button("撤销令牌").click());
	expect(revokeToken).toHaveBeenCalledWith("a", "t");
	expect(container.textContent).toContain("已撤销");
	expect(button("保存标签与权限").disabled).toBe(true);
	expect(button("撤销令牌").disabled).toBe(true);
	expect(storageWrite).not.toHaveBeenCalled();
});

it("shows token-management failures without exposing upstream details", async () => {
	vi.mocked(listTokens).mockRejectedValue(new Error("private upstream failure"));
	await act(async () =>
		root.render(
			<TooltipProvider>
				<ApiTokens accounts={[account]} />
			</TooltipProvider>,
		),
	);
	expect(container.textContent).toContain("无法读取 API 令牌");
	vi.mocked(createToken).mockRejectedValue(new Error("private upstream failure"));
	await act(async () =>
		container
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
	);
	expect(container.textContent).toContain("操作失败");
	expect(container.textContent).not.toContain("private upstream failure");
	expect(button("创建令牌").disabled).toBe(false);
});

it("recovers the management list after a failed initial read and a successful create", async () => {
	vi.mocked(listTokens).mockRejectedValueOnce(new Error("private upstream failure"));
	await act(async () =>
		root.render(
			<TooltipProvider>
				<ApiTokens accounts={[account]} />
			</TooltipProvider>,
		),
	);
	expect(container.textContent).toContain("无法读取 API 令牌");
	vi.mocked(createToken).mockResolvedValue({ ...row, token: "giraffe_test_once" });
	vi.mocked(listTokens).mockResolvedValue({ account_id: "a", items: [row] });
	await act(async () =>
		container
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
	);
	expect(container.textContent).not.toContain("无法读取 API 令牌");
	expect(container.textContent).toContain("共 1 个");
	expect(
		container.querySelector<HTMLInputElement>('[aria-label="新 API 令牌（仅显示一次）"]')?.value,
	).toBe("giraffe_test_once");
	expect(container.querySelector<HTMLInputElement>('[aria-label="External Bot 标签"]')?.value).toBe(
		"External Bot",
	);
});

it.each(["success", "failure"])(
	"ignores the old initial token list %s after successful creation and reload",
	async (outcome) => {
		let resolve: (value: { account_id: string; items: ApiTokenRow[] }) => void = () => {};
		let reject: (error: Error) => void = () => {};
		vi.mocked(listTokens).mockReturnValueOnce(
			new Promise((done, fail) => {
				resolve = done;
				reject = fail;
			}),
		);
		await act(async () =>
			root.render(
				<TooltipProvider>
					<ApiTokens accounts={[account]} />
				</TooltipProvider>,
			),
		);
		vi.mocked(createToken).mockResolvedValue({ ...row, token: "giraffe_test_once" });
		vi.mocked(listTokens).mockResolvedValue({ account_id: "a", items: [row] });
		await act(async () =>
			container
				.querySelector("form")
				?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
		);
		await act(async () => {
			if (outcome === "failure") reject(new Error("private upstream failure"));
			else resolve({ account_id: "a", items: [] });
		});
		expect(container.textContent).not.toContain("无法读取 API 令牌");
		expect(container.textContent).toContain("共 1 个");
		expect(container.querySelector('[aria-label="External Bot 标签"]')).not.toBeNull();
	},
);

it("ignores a token list that arrives after changing account", async () => {
	let resolve: (value: { account_id: string; items: ApiTokenRow[] }) => void = () => {};
	vi.mocked(listTokens).mockReturnValueOnce(
		new Promise((done) => {
			resolve = done;
		}),
	);
	await act(async () =>
		root.render(
			<TooltipProvider>
				<ApiTokens accounts={[account]} />
			</TooltipProvider>,
		),
	);
	await act(async () =>
		root.render(
			<TooltipProvider>
				<ApiTokens accounts={[{ ...account, id: "other" }]} />
			</TooltipProvider>,
		),
	);
	await act(async () =>
		resolve({ account_id: "a", items: [{ ...row, label: "Old account token" }] }),
	);
	expect(container.textContent).not.toContain("Old account token");
	expect(listTokens).toHaveBeenCalledWith("other");
});
