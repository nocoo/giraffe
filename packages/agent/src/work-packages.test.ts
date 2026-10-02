import { expect, it, vi } from "vitest";
import { latestPackage } from "./work-packages.ts";

it("resolves the latest stable version and compatibility metadata from the approved registry", async () => {
	const fetcher = vi.fn(async () =>
		Response.json({
			name: "@scope/pkg",
			version: "3.2.1",
			engines: { node: ">=22" },
			peerDependencies: { peer: "^2" },
			dependencies: { child: "^1" },
		}),
	);
	expect(
		await latestPackage("@scope/pkg", "https://mirrors.tencent.com/npm/", fetcher as typeof fetch),
	).toMatchObject({ name: "@scope/pkg", version: "3.2.1", peerDependencies: { peer: "^2" } });
	expect(fetcher).toHaveBeenCalledWith(
		"https://mirrors.tencent.com/npm/%40scope%2Fpkg/latest",
		expect.objectContaining({ redirect: "error" }),
	);
	for (const metadata of [
		{ name: "other", version: "3.2.1" },
		{ name: "@scope/pkg", version: "4.0.0-beta.1" },
		{ name: "@scope/pkg", version: "bad" },
		{ name: "@scope/pkg", version: "3.2.1", deprecated: "unsafe" },
	]) {
		fetcher.mockResolvedValueOnce(Response.json(metadata));
		await expect(
			latestPackage("@scope/pkg", "https://mirrors.tencent.com/npm", fetcher as typeof fetch),
		).rejects.toThrow();
	}
	fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
	await expect(
		latestPackage("pkg", "https://mirrors.tencent.com/npm", fetcher as typeof fetch),
	).rejects.toThrow(/metadata/);
	await expect(
		latestPackage("../secret", "https://mirrors.tencent.com/npm", fetcher as typeof fetch),
	).rejects.toThrow();
	await expect(
		latestPackage("pkg", "https://registry.npmjs.org", fetcher as typeof fetch),
	).rejects.toThrow(/mirror/);
});
