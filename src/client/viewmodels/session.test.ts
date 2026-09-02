// @vitest-environment happy-dom
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

	it("ignores a stale accounts GET after the local stamp changes", async () => {
		let release!: (value: Response) => void;
		const gate = new Promise<Response>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return gate;
			}
			throw new Error(String(input));
		});
		const pending = ensureSession();
		setActiveAccountId("acc2");
		release(
			Response.json({
				accounts: [{ id: "acc1", login: "a", is_active: true }],
			}),
		);
		expect(await pending).toBe("acc2");
		expect(getActiveAccountId()).toBe("acc2");
	});

	it("rejects a stale session GET after the stamp is cleared", async () => {
		setActiveAccountId("acc1");
		let release!: (value: Response) => void;
		const gate = new Promise<Response>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			if (String(input) === "/api/accounts") {
				return gate;
			}
			throw new Error(String(input));
		});
		const pending = ensureSession();
		setActiveAccountId(null);
		release(Response.json({ accounts: [{ id: "acc1", login: "a", is_active: true }] }));
		await expect(pending).rejects.toBeInstanceOf(ApiError);
	});
});
