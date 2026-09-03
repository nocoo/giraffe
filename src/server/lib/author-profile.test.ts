import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUTHOR_PROFILE_URL,
	fetchAuthorProfile,
	hashEmail,
	normalizeEmail,
	parseAuthorProfile,
} from "./author-profile";

const KNOWN_EMAIL = "architie@gmail.com";
const KNOWN_HASH = "7ba563171c26fb9b82e9f7750840c0455602eb35025192027230bcb40aae1217";

describe("author profile", () => {
	it("normalizes and hashes email without putting it on the wire", async () => {
		expect(normalizeEmail("  Architie@Gmail.com  ")).toBe(KNOWN_EMAIL);
		expect(await hashEmail(KNOWN_EMAIL)).toBe(KNOWN_HASH);
		expect(await hashEmail("  Architie@Gmail.com  ")).toBe(KNOWN_HASH);
		expect(await hashEmail("someone@example.com")).toMatch(/^[0-9a-f]{64}$/);
		expect(parseAuthorProfile({ name: "Zheng Li", avatar: "https://cdn.example/a.jpg" })).toEqual({
			name: "Zheng Li",
			avatar: "https://cdn.example/a.jpg",
		});
		expect(parseAuthorProfile({ name: null, avatar: null })).toEqual({ name: null, avatar: null });
		expect(parseAuthorProfile({ name: "", avatar: "" })).toEqual({ name: null, avatar: null });
		expect(parseAuthorProfile(null)).toEqual({ name: null, avatar: null });
		expect(parseAuthorProfile("nope")).toEqual({ name: null, avatar: null });
	});

	describe("fetchAuthorProfile", () => {
		const fetchMock = vi.fn();

		beforeEach(() => {
			fetchMock.mockReset();
			vi.stubGlobal("fetch", fetchMock);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("GETs lizheng.blog with the hash and never the email", async () => {
			fetchMock.mockResolvedValue(
				new Response(JSON.stringify({ name: "Zheng Li", avatar: "https://cdn.example/a.jpg" }), {
					status: 200,
				}),
			);
			await expect(fetchAuthorProfile(KNOWN_EMAIL)).resolves.toEqual({
				name: "Zheng Li",
				avatar: "https://cdn.example/a.jpg",
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(`${AUTHOR_PROFILE_URL}?hash=${KNOWN_HASH}`);
			expect(url).not.toContain("@");
			expect(url).not.toContain("architie");
			expect(init.signal).toBeInstanceOf(AbortSignal);
			expect(JSON.stringify(init)).not.toContain(KNOWN_EMAIL);
		});

		it("returns nulls on 429 and network failure", async () => {
			fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));
			await expect(fetchAuthorProfile(KNOWN_EMAIL)).resolves.toEqual({
				name: null,
				avatar: null,
			});
			fetchMock.mockRejectedValue(new Error("offline"));
			await expect(fetchAuthorProfile(KNOWN_EMAIL)).resolves.toEqual({
				name: null,
				avatar: null,
			});
		});
	});
});
