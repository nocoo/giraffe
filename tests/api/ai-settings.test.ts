import { expect, it } from "vitest";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const suite = process.env.GIRAFFE_SUITE ?? "A";
const origin = "https://giraffe.dev.hexly.ai";
const fakeKey = "fake-ai-http-test-key";

it("protects AI routes and persists each encrypted configuration over local HTTP", async () => {
	expect(new URL(base).hostname).toBe("127.0.0.1");
	const headers = new Headers({ origin, "content-type": "application/json" });
	if (suite === "B") headers.set("Cf-Access-Jwt-Assertion", process.env.GIRAFFE_JWT ?? "");
	const api = (path: string, method = "GET", body?: unknown) =>
		fetch(`${base}/api/${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	for (const kind of ["summary", "judgment"]) {
		const path = `ai/settings/${kind}`;
		if (suite === "B")
			for (const [target, method] of [
				["ai/settings", "GET"],
				[path, "POST"],
				[`${path}/test`, "POST"],
				[path, "DELETE"],
				["repos/octocat/hello-world/assessment", "GET"],
			]) {
				expect((await fetch(`${base}/api/${target}`, { method, headers: { origin } })).status).toBe(
					401,
				);
			}
		expect((await api(path, "PUT")).status).toBe(405);
		expect((await api(`${path}/test`)).status).toBe(405);
		const draft =
			kind === "summary"
				? {
						apiKey: fakeKey,
						model: "unit",
						baseURL: "https://models.example.test/v1",
						sdkType: "openai",
						authType: "apiKey",
					}
				: { apiKey: fakeKey };
		try {
			const response = await api(path, "POST", draft);
			expect(response.status).toBe(200);
			expect(await response.text()).not.toContain(fakeKey);
			const settings = await api("ai/settings");
			expect(settings.headers.get("cache-control")).toContain("no-store");
			const text = await settings.text();
			expect(text).not.toContain(fakeKey);
			expect(
				JSON.parse(text).settings.find((item: { kind: string }) => item.kind === kind),
			).toMatchObject({ hasApiKey: true });
			expect((await api(`${path}/test`, "POST", { apiKey: "invalid key" })).status).toBe(400);
		} finally {
			expect((await api(path, "DELETE")).status).toBe(204);
		}
	}
	expect((await api("repos/octocat/hello-world/assessment", "POST")).status).toBe(405);
});
