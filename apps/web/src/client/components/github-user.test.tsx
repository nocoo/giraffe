// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { githubAvatarColor } from "../lib/github-avatar";

vi.mock("@nocoo/basalt", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@nocoo/basalt")>();
	return {
		...actual,
		AvatarImage: ({ src, alt, onError }: { src?: string; alt?: string; onError?: () => void }) => (
			<img src={src} alt={alt} onError={onError} />
		),
	};
});

import { GithubAvatar, UserChip } from "./github-user";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
	act(() => {
		root?.unmount();
	});
	root = null;
	container = null;
});

function render(node: Parameters<Root["render"]>[0]) {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root?.render(node);
	});
	return container;
}

it("UserChip renders login with a github avatar url", () => {
	const view = render(<UserChip login="octocat" />);
	const image = view.querySelector("img");
	expect(image?.getAttribute("src")).toContain("avatars.githubusercontent.com/octocat");
	expect(view.textContent).toContain("octocat");
});

it("GithubAvatar uses a deterministic colored fallback after image error", () => {
	const view = render(<GithubAvatar login="octocat" avatarUrl="https://bad.example/a.png" />);
	const image = view.querySelector("img");
	expect(image).not.toBeNull();
	act(() => {
		image?.dispatchEvent(new Event("error"));
	});
	expect(view.querySelector("img")).toBeNull();
	const fallback = view.querySelector('[data-testid="github-avatar-fallback"]');
	expect(fallback?.textContent).toBe("O");
	expect((fallback as HTMLElement | null)?.style.backgroundColor).toBe(
		githubAvatarColor("octocat"),
	);
	expect((fallback as HTMLElement | null)?.style.color).toMatch(/255,\s*255,\s*255|#fff/i);
});
