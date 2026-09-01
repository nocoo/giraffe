import { describe, expect, it } from "vitest";
import worker from "./index";

describe("worker fetch", () => {
	it("returns giraffe", async () => {
		const response = await worker.fetch(new Request("http://localhost/"));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("giraffe");
	});
});
