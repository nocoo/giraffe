import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("loads the web manifest with credentials for Cloudflare Access", () => {
	const html = readFileSync("apps/web/index.html", "utf8");
	const manifestLink = html.match(/<link rel="manifest"[^>]*>/i)?.[0];
	expect(manifestLink).toBeDefined();
	expect(manifestLink).toContain('href="/manifest.webmanifest"');
	expect(manifestLink).toContain('crossorigin="use-credentials"');
});

it("keeps PWA assets on same-origin paths", () => {
	const manifest = JSON.parse(readFileSync("apps/web/public/manifest.webmanifest", "utf8")) as {
		start_url: string;
		scope: string;
		icons: { src: string }[];
	};
	expect(manifest.start_url).toMatch(/^\//);
	expect(manifest.scope).toMatch(/^\//);
	for (const icon of manifest.icons) {
		expect(icon.src).toMatch(/^\//);
		expect(icon.src).not.toMatch(/^https?:\/\//);
	}
	const main = readFileSync("apps/web/src/client/main.tsx", "utf8");
	expect(main).toContain('const serviceWorkerUrl = "/sw.js"');
	expect(main).toContain("navigator.serviceWorker.register(serviceWorkerUrl");
});
