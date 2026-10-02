import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { readJson } from "./read-body";

describe("readJson", () => {
	it("parses json and rejects oversized bodies", async () => {
		const ok = new Request("http://x", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ a: 1 }),
		});
		expect(await readJson(ok, 1000)).toEqual({ a: 1 });
		const big = new Request("http://x", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "x".repeat(50),
		});
		await expect(readJson(big, 10)).rejects.toBeInstanceOf(ApiError);
		await expect(
			readJson(new Request("http://x", { method: "POST", body: "{}" }), 100),
		).rejects.toBeInstanceOf(ApiError);
		const empty = new Request("http://x", {
			method: "POST",
			headers: { "content-type": "application/json" },
		});
		await expect(readJson(empty, 100)).rejects.toBeInstanceOf(ApiError);
		const bad = new Request("http://x", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		await expect(readJson(bad, 100)).rejects.toBeInstanceOf(ApiError);
		await expect(
			readJson(
				new Request("http://x", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: new Uint8Array([0xff, 0xfe, 0x22, 0x61, 0x22]),
				}),
				100,
			),
		).rejects.toBeInstanceOf(ApiError);
		await expect(
			readJson(
				new Request("http://x", {
					method: "POST",
					headers: { "content-type": "application/json; charset=iso-8859-1" },
					body: "{}",
				}),
				100,
			),
		).rejects.toBeInstanceOf(ApiError);
	});
});
