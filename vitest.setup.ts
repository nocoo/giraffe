import { vi } from "vitest";

function denyNetwork(): Promise<Response> {
	throw new Error("network denied in L1");
}

vi.stubGlobal("fetch", denyNetwork);
