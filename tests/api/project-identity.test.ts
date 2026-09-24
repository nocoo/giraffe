import { expect, it } from "vitest";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";
const suite = process.env.GIRAFFE_SUITE ?? "A";
const path = "/api/projects/Team/App.Web-Kit";

it("serves one projected identity over authenticated local HTTP with no persistence", async () => {
	expect(new URL(base).hostname).toBe("127.0.0.1");
	const headers = new Headers({ origin: "https://giraffe.dev.hexly.ai" });
	if (suite === "B") {
		for (const token of [
			"",
			process.env.GIRAFFE_JWT_BAD_AUD ?? "",
			process.env.GIRAFFE_JWT_BAD_SIG ?? "",
		])
			expect(
				(await fetch(`${base}${path}`, { headers: { "Cf-Access-Jwt-Assertion": token } })).status,
			).toBe(401);
		headers.set("Cf-Access-Jwt-Assertion", process.env.GIRAFFE_JWT ?? "");
	}
	const api = (target = path, method = "GET") => fetch(`${base}${target}`, { method, headers });
	const success = await api();
	expect(success.status).toBe(200);
	expect(success.headers.get("cache-control")).toBe("no-store");
	const project = await success.json();
	expect(project).toMatchObject({
		owner: "team",
		repo: "app.web-kit",
		title: "App Web Kit",
		description: "A small toolkit for the web",
		archived: true,
		github: "https://github.com/team/app.web-kit",
		website: "https://app.example.test",
	});
	expect(project).not.toHaveProperty("brand");
	expect(project).not.toHaveProperty("logos");
	for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
		expect((await api(path, method)).status).toBe(405);
	expect((await api(`${path}?all=1`)).status).toBe(400);
	expect((await api("/api/projects/team/invalid!")).status).toBe(400);
	expect(await (await api("/api/projects/other/app.web-kit")).json()).toBeNull();
	const unavailable = await api("/api/projects/team/unavailable");
	expect(unavailable.status).toBe(503);
	expect(unavailable.headers.get("cache-control")).toBe("no-store");
	expect(await unavailable.text()).not.toContain("upstream diagnostics");
});
