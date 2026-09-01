import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/errors";
import { allowedOrigin, assertOrigin, originFromEnv } from "./origin";

describe("origin", () => {
	it("allows GET without origin and rejects bad POST origins", () => {
		assertOrigin(new Request("http://x/api/repos"), "development");
		assertOrigin(
			new Request("http://x/api/refresh", {
				method: "POST",
				headers: { Origin: "https://giraffe.dev.hexly.ai" },
			}),
			"development",
		);
		expect(() =>
			assertOrigin(new Request("http://x/api/refresh", { method: "POST" }), "development"),
		).toThrow(ApiError);
		expect(() =>
			assertOrigin(
				new Request("http://x/api/refresh", {
					method: "DELETE",
					headers: { Origin: "http://127.0.0.1:17045" },
				}),
				"development",
			),
		).toThrow(ApiError);
		expect(allowedOrigin("production")).toBe("https://giraffe.hexly.ai");
		expect(originFromEnv("test")).toBe("https://giraffe.dev.hexly.ai");
		assertOrigin(new Request("http://x/api/repos", { method: "HEAD" }), "production");
		assertOrigin(new Request("http://x/api/repos", { method: "OPTIONS" }), "development");
	});
});
