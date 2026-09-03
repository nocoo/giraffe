import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { createApp } from "../index";
import { AUTHOR_PROFILE_URL, hashEmail } from "../lib/author-profile";
import { openSqliteD1 } from "../lib/db/sqlite-d1";

function env(): Env {
	return {
		DB: openSqliteD1(true),
		ASSETS: {
			fetch: async () => new Response("asset"),
		} as unknown as Fetcher,
		TOKEN_ENCRYPTION_KEY_CURRENT: "1",
		ENVIRONMENT: "development",
		GITHUB_API_BASE: "http://127.0.0.1:17046",
	};
}

describe("GET /api/me", () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ name: null, avatar: null }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("fills avatar from lizheng.blog and keeps access email", async () => {
		const miss = await createApp().request("http://localhost/api/me", {}, env());
		expect(miss.status).toBe(200);
		expect(await miss.json()).toEqual({ email: "dev@local", name: "dev", avatar: null });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toBe(`${AUTHOR_PROFILE_URL}?hash=${await hashEmail("dev@local")}`);
		expect(url).not.toContain("dev@local");

		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ name: "Zheng Li", avatar: "https://cdn.example/avatar-80.jpg" }),
				{ status: 200 },
			),
		);
		const hit = await createApp().request("http://localhost/api/me", {}, env());
		expect(await hit.json()).toEqual({
			email: "dev@local",
			name: "Zheng Li",
			avatar: "https://cdn.example/avatar-80.jpg",
		});
	});
});
