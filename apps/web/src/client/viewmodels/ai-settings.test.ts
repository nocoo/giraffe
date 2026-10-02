import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAiSettings } from "../../lib/ai-settings";
import { ApiError } from "../lib/errors";
import {
	aiSettingsError,
	canSubmitAiSettings,
	deleteAiSettings,
	draftAiSettings,
	loadAiSettings,
	saveAiSettings,
	testAiSettings,
} from "./ai-settings";

describe("AI settings viewmodel", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("uses empty in-memory keys and requires a new key when changing destinations", () => {
		const saved = { ...defaultAiSettings("summary"), model: "model", hasApiKey: true };
		const draft = draftAiSettings(saved);
		expect(draft.apiKey).toBe("");
		expect(canSubmitAiSettings(draft, saved, false)).toBe(true);
		expect(canSubmitAiSettings(draft, saved, true)).toBe(false);
		expect(canSubmitAiSettings({ ...draft, model: " " }, saved, false)).toBe(false);
		expect(canSubmitAiSettings({ ...draft, baseURL: " " }, saved, false)).toBe(false);
		expect(canSubmitAiSettings({ ...draft, baseURL: "https://new.example/v1" }, saved, false)).toBe(
			false,
		);
		expect(canSubmitAiSettings({ ...draft, sdkType: "anthropic" }, saved, false)).toBe(false);
		expect(canSubmitAiSettings({ ...draft, authType: "bearer" }, saved, false)).toBe(false);
		expect(
			canSubmitAiSettings(
				{ ...draft, apiKey: "new-key", baseURL: "https://new.example" },
				saved,
				false,
			),
		).toBe(true);
		expect(canSubmitAiSettings(draft, { ...saved, hasApiKey: false }, false)).toBe(false);
	});
	it("loads public configurations and independently saves or tests each draft", async () => {
		const saved = defaultAiSettings("judgment");
		const draft = { ...draftAiSettings(saved), apiKey: "fake-test-key" };
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${path}`);
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			if (init?.method === "POST") expect(JSON.parse(String(init.body))).toEqual(draft);
			return Response.json(
				path.endsWith("/test")
					? { ok: true }
					: init?.method === "POST"
						? { ...saved, hasApiKey: true }
						: { settings: [saved] },
			);
		});
		expect(await loadAiSettings()).toEqual([saved]);
		expect(await saveAiSettings("judgment", draft)).toMatchObject({ hasApiKey: true });
		await testAiSettings("judgment", draft);
		await deleteAiSettings("judgment");
		expect(calls).toEqual([
			"GET /api/ai/settings",
			"POST /api/ai/settings/judgment",
			"POST /api/ai/settings/judgment/test",
			"DELETE /api/ai/settings/judgment",
		]);
	});
	it("shows safe localized errors without displaying provider payloads", () => {
		expect(aiSettingsError(new ApiError(400, "validation_failed", "secret-body"))).toBe(
			"请检查模型、API 地址和 API key；更换服务地址或协议后需要重新输入 key。",
		);
		expect(aiSettingsError(new ApiError(500, "encryption_misconfigured", "secret-body"))).toBe(
			"服务端加密配置不可用，请先检查加密密钥。",
		);
		expect(aiSettingsError(new ApiError(502, "internal_error", "secret-body"))).toBe(
			"请求失败，请检查服务地址、模型和 API key 后重试。",
		);
		expect(aiSettingsError(new Error("secret-body"))).toBe(
			"请求失败，请检查服务地址、模型和 API key 后重试。",
		);
	});
});
