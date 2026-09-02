import { describe, expect, it } from "vitest";
import { ACCOUNT_ID_RE, createId } from "./id";

describe("createId", () => {
	it("returns 21 url-safe characters", () => {
		const id = createId();
		expect(id).toHaveLength(21);
		expect(ACCOUNT_ID_RE.test(id)).toBe(true);
		expect(ACCOUNT_ID_RE.test("x")).toBe(false);
		expect(createId()).not.toBe(id);
	});
});
