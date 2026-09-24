import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectIdentity } from "../../lib/project-identity";
import { projectKey } from "../../lib/project-identity";
import { apiGet } from "../lib/api";
import { cachedProjectIdentity, loadProjectIdentity } from "./project-identity";

vi.mock("../lib/api", () => ({ apiGet: vi.fn() }));

const project: ProjectIdentity = {
	owner: "team",
	repo: "app.web-kit",
	title: "App",
	description: "A project description",
	archived: false,
	github: "https://github.com/team/app.web-kit",
	website: null,
	url: "https://hexly.ai/projects/app",
	icons: { small: "https://cdn.example/small.png", large: "https://cdn.example/large.png" },
	navigationIcon: "https://cdn.example/nav.png",
	favicon: "https://cdn.example/favicon.png",
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-24T00:00:00Z"));
	vi.mocked(apiGet).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("project identities", () => {
	it("keys by owner and repository, preserving dots and hyphens", () => {
		expect(projectKey("TEAM/App.Web-Kit")).toBe("team/app.web-kit");
		for (const name of [
			"repo",
			"a/b/c",
			"/repo",
			"owner/",
			"-bad/app",
			"a/..",
			"a/.",
			"a/x?y",
			"a/x y",
			"a_/b",
		])
			expect(projectKey(name)).toBeNull();
	});

	it("deduplicates pending requests and caches successes for one hour only", async () => {
		let finish!: (value: ProjectIdentity) => void;
		vi.mocked(apiGet).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		expect(cachedProjectIdentity("TEAM/App.Web-Kit")).toBeNull();
		const first = loadProjectIdentity("TEAM/App.Web-Kit");
		const second = loadProjectIdentity("team/app.web-kit");
		expect(apiGet).toHaveBeenCalledExactlyOnceWith("projects/team/app.web-kit");
		finish(project);
		expect(await first).toEqual(project);
		expect(await second).toEqual(project);
		vi.advanceTimersByTime(3_599_999);
		expect(await loadProjectIdentity("team/app.web-kit")).toEqual(project);
		expect(apiGet).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(cachedProjectIdentity("team/app.web-kit")).toBeNull();
		vi.mocked(apiGet).mockResolvedValueOnce({ ...project, title: "Updated" });
		expect(await loadProjectIdentity("team/app.web-kit")).toMatchObject({ title: "Updated" });
		expect(apiGet).toHaveBeenCalledTimes(2);
	});

	it("does not cache unknown repositories or failures and never requests malformed names", async () => {
		vi.mocked(apiGet).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("offline"));
		expect(await loadProjectIdentity("other/app")).toBeNull();
		expect(await loadProjectIdentity("other/app")).toBeNull();
		vi.mocked(apiGet).mockResolvedValueOnce({ ...project, owner: "other", repo: "app" });
		expect(await loadProjectIdentity("other/app")).toMatchObject({ owner: "other" });
		expect(apiGet).toHaveBeenCalledTimes(3);
		expect(await loadProjectIdentity("a/b/c")).toBeNull();
		expect(cachedProjectIdentity("a/b/c")).toBeNull();
		expect(apiGet).toHaveBeenCalledTimes(3);
	});
});
