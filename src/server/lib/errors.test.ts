import { describe, expect, it } from "vitest";
import { ApiError, errorResponse, jsonError, jsonOk } from "./errors";

describe("errors", () => {
	it("returns the envelope and sanitizes PAT in messages", async () => {
		const pat = `ghp_${"b".repeat(36)}`;
		const err = new ApiError(400, "validation_failed", `bad ${pat}`);
		expect(err.message).toBe("bad [redacted]");
		const res = jsonError(401, "access_unauthorized", `no ${pat}`);
		expect(res.status).toBe(401);
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(await res.json()).toEqual({
			error: { code: "access_unauthorized", message: "no [redacted]" },
		});
		const wrapped = errorResponse(err);
		expect(wrapped.status).toBe(400);
		const created = jsonOk({ ok: true }, 201);
		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({ ok: true });
		expect((await jsonOk({ a: 1 })).status).toBe(200);
	});
});
