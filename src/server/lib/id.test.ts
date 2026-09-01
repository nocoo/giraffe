import { describe, expect, it } from "vitest";
import { createId } from "./id";

describe("createId", () => {
	it("returns 21 url-safe characters", () => {
		const id = createId();
		expect(id).toHaveLength(21);
		expect(id).toMatch(/^[0-9A-Za-z_-]+$/);
		expect(createId()).not.toBe(id);
	});
});
