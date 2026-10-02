import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProjectIdentity, parseProjectIdentity } from "./project-identity";

const icon = "https://cdn.example/mark.png";
const logo = (width: number, extra = {}) => ({
	url: `https://cdn.example/nav-${width}.png`,
	width,
	height: width,
	format: "png",
	role: "project-identity",
	background: "transparent",
	usage: "navigation",
	theme: "any",
	...extra,
});
const metadata = {
	schemaVersion: 1,
	owner: "TEAM",
	repo: "app.web-kit",
	title: "App",
	description: { en: "English", zh: "中文" },
	archived: true,
	github: "https://github.com/TEAM/app.web-kit",
	website: null,
	url: "https://hexly.ai/projects/app",
	icons: { small: icon, large: icon },
	logos: [
		logo(512),
		logo(32),
		logo(64),
		logo(48),
		logo(64, { role: "hexly-campaign", url: "https://cdn.example/campaign.png" }),
	],
	brand: { manifest: "unused", source: "unused" },
	category: "unused",
	emoji: "unused",
};

afterEach(() => vi.unstubAllGlobals());

describe("Hexly identity projection", () => {
	it("keeps English text and supplied URLs, selecting transparent identity navigation PNGs", () => {
		expect(parseProjectIdentity(metadata, "team/app.web-kit")).toEqual({
			owner: "TEAM",
			repo: "app.web-kit",
			title: "App",
			description: "English",
			archived: true,
			github: metadata.github,
			website: null,
			url: metadata.url,
			icons: metadata.icons,
			navigationIcon: "https://cdn.example/nav-64.png",
			favicon: "https://cdn.example/nav-32.png",
		});
	});
	it("uses supplied icons when no navigation variant is suitable", () => {
		for (const logos of [
			[],
			[logo(16)],
			[logo(64, { background: "original" })],
			[logo(64, { theme: "dark" })],
			[logo(64, { format: "webp" })],
			[logo(64, { usage: "apple-touch-icon" })],
		]) {
			expect(
				parseProjectIdentity(
					{ ...metadata, logos, website: "https://app.example" },
					"team/app.web-kit",
				),
			).toMatchObject({ navigationIcon: icon });
		}
	});
	it("rejects mismatched identities, malformed data and unsafe URLs", () => {
		for (const data of [
			null,
			{},
			{ ...metadata, schemaVersion: 2 },
			{ ...metadata, owner: "someone" },
			{ ...metadata, github: "https://github.com/other/app" },
			{ ...metadata, website: "javascript:alert(1)" },
			{ ...metadata, icons: { small: "http://insecure.example/a", large: icon } },
		])
			expect(() => parseProjectIdentity(data, "team/app.web-kit")).toThrow();
	});
	it("requests one normalized pair without credentials, queries or authentication headers", async () => {
		const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(metadata)));
		vi.stubGlobal("fetch", fetch);
		await fetchProjectIdentity("TEAM/App.Web-Kit");
		expect(fetch).toHaveBeenCalledWith("https://hexly.ai/api/projects/team/app.web-kit", {
			signal: expect.any(AbortSignal),
			redirect: "manual",
		});
		await expect(fetchProjectIdentity("a/b/c")).rejects.toMatchObject({ status: 400 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("returns null for unknown repositories and safe errors for temporary failures", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
		vi.stubGlobal("fetch", fetch);
		expect(await fetchProjectIdentity("a/app")).toBeNull();
		for (const status of [400, 405, 503]) {
			fetch.mockResolvedValueOnce(new Response("private upstream diagnostics", { status }));
			await expect(fetchProjectIdentity("a/app")).rejects.toMatchObject({
				status: 503,
				message: "project identity unavailable",
			});
		}
		fetch.mockRejectedValueOnce(new Error("private diagnostics"));
		await expect(fetchProjectIdentity("a/app")).rejects.toMatchObject({
			status: 503,
			message: "project identity unavailable",
		});
		fetch.mockResolvedValueOnce(new Response("invalid json"));
		await expect(fetchProjectIdentity("a/app")).rejects.toMatchObject({ status: 503 });
	});
});
