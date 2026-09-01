import { describe, expect, it } from "vitest";

const base = process.env.GIRAFFE_E2E ?? "http://127.0.0.1:17045";

describe("GET /api/live", () => {
	it("returns version and d1_marker without origin", async () => {
		const res = await fetch(`${base}/api/live`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string; d1_marker: string };
		expect(body.name).toBe("giraffe");
		expect(body.d1_marker).toBe("test");
	});
});
