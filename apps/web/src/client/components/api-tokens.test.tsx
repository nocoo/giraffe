// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ApiTokens } from "./api-tokens";

it("offers external bot tokens without local runtime or CLI consent wording", () => {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(<ApiTokens accounts={[]} />);
	expect(container.textContent).toContain("外部 Bot API 令牌");
	expect(container.querySelector<HTMLInputElement>('[aria-label="新令牌标签"]')?.value).toBe(
		"External Bot",
	);
	expect(container.textContent).not.toMatch(/本地 Agent|CLI|PKCE/);
	expect(container.textContent).toContain("原文只显示一次");
	expect(container.textContent).toContain("撤销立即生效");
	expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
});
