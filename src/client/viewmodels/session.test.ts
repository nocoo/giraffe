import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/errors";
import { cacheGeneration, ensureSession, getActiveAccountId, setActiveAccountId } from "./session";

describe("session", () => {
	afterEach(() => {
		setActiveAccountId(null);
		vi.stubGlobal("fetch", () => {
			throw new Error("network denied in L1");
		});
	});

	it("reads active account and bumps cache on switch", async () => {
		vi.stubGlobal("fetch", async () =>
			Response.json({
				accounts: [
					{ id: "a1", login: "a", is_active: false },
					{ id: "a2", login: "b", is_active: true },
				],
			}),
		);
		const gen = cacheGeneration();
		expect(await ensureSession()).toBe("a2");
		expect(getActiveAccountId()).toBe("a2");
		expect(cacheGeneration()).toBeGreaterThan(gen);
		await expect(
			(async () => {
				vi.stubGlobal("fetch", async () => Response.json({ accounts: [] }));
				await ensureSession();
			})(),
		).rejects.toBeInstanceOf(ApiError);
		expect(getActiveAccountId()).toBeNull();
	});
});
