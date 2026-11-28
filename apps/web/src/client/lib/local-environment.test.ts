import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	vi.resetModules();
	vi.unstubAllGlobals();
});

it("keeps hosted requests unchanged when no local runtime global is injected", async () => {
	vi.stubGlobal("window", {});
	const environment = await import("./local-environment");
	expect(environment.getLocalEnvironment()).toBeUndefined();
	expect(environment.isRemoteReadOnly()).toBe(false);
});

it("freezes the bootstrapped target and blocks Prod writes before fetch", async () => {
	const win: { __GIRAFFE_LOCAL__?: unknown } = {
		__GIRAFFE_LOCAL__: { mode: "prod", instanceId: "prod-one", csrfToken: "csrf" },
	};
	vi.stubGlobal("window", win);
	const environment = await import("./local-environment");
	const { apiGet, apiPost, apiDelete, apiWrite } = await import("./api");
	const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
	vi.stubGlobal("fetch", fetcher);
	win.__GIRAFFE_LOCAL__ = { mode: "local", instanceId: "other", csrfToken: "other" };
	expect(environment.isRemoteReadOnly()).toBe(true);
	await apiGet("ci?scope=all");
	expect(fetcher.mock.lastCall).toEqual([
		"/api/ci?scope=all",
		expect.objectContaining({ headers: expect.any(Headers) }),
	]);
	const init = fetcher.mock.lastCall?.[1] as RequestInit | undefined;
	expect(new Headers(init?.headers).get("x-giraffe-local-instance")).toBe("prod-one");
	fetcher.mockClear();
	for (const action of [
		() => apiPost("accounts", { token: "fake" }),
		() => apiDelete("accounts/a"),
		() => apiWrite("tokens/a", "PATCH", {}),
	])
		await expect(action()).rejects.toMatchObject({ code: "local_read_only" });
	expect(fetcher).not.toHaveBeenCalled();
	await apiPost("__local/environment", { mode: "local" });
	const selected = fetcher.mock.lastCall?.[1] as RequestInit | undefined;
	expect(new Headers(selected?.headers).get("x-giraffe-local-csrf")).toBe("csrf");
	expect(environment.getLocalEnvironment()?.instanceId).toBe("prod-one");
});

it("keeps Local writes working with the instance and content type intact", async () => {
	vi.stubGlobal("window", {
		__GIRAFFE_LOCAL__: { mode: "local", instanceId: "local-one", csrfToken: "csrf" },
	});
	const { apiPost } = await import("./api");
	const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
	vi.stubGlobal("fetch", fetcher);
	await apiPost("accounts", { token: "fake" });
	const headers = new Headers(fetcher.mock.lastCall?.[1]?.headers);
	expect(headers.get("x-giraffe-local-instance")).toBe("local-one");
	expect(headers.get("content-type")).toBe("application/json");
	expect(headers.has("x-giraffe-local-csrf")).toBe(false);
});
