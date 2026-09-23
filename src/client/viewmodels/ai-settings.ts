import {
	type AiKind,
	type AiSettingsDraft,
	type PublicAiSettings,
	sameAiDestination,
} from "../../lib/ai-settings";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";

export function draftAiSettings(settings: PublicAiSettings): AiSettingsDraft {
	return {
		model: settings.model,
		baseURL: settings.baseURL,
		sdkType: settings.sdkType,
		authType: settings.authType,
		apiKey: "",
	};
}

export function canSubmitAiSettings(
	draft: AiSettingsDraft,
	saved: PublicAiSettings,
	busy: boolean,
): boolean {
	return (
		!busy &&
		draft.model.trim().length > 0 &&
		draft.baseURL.trim().length > 0 &&
		(draft.apiKey.length > 0 || (saved.hasApiKey && sameAiDestination(draft, saved)))
	);
}

export function aiSettingsError(error: unknown): string {
	if (error instanceof ApiError && error.code === "validation_failed")
		return "请检查模型、API 地址和 API key；更换服务地址或协议后需要重新输入 key。";
	if (error instanceof ApiError && error.code === "encryption_misconfigured")
		return "服务端加密配置不可用，请先检查加密密钥。";
	return "请求失败，请检查服务地址、模型和 API key 后重试。";
}

export async function loadAiSettings(): Promise<PublicAiSettings[]> {
	return (await apiGet<{ settings: PublicAiSettings[] }>("ai/settings")).settings;
}

export async function saveAiSettings(
	kind: AiKind,
	draft: AiSettingsDraft,
): Promise<PublicAiSettings> {
	return apiPost<PublicAiSettings>(`ai/settings/${kind}`, draft);
}

export async function testAiSettings(kind: AiKind, draft: AiSettingsDraft): Promise<void> {
	await apiPost(`ai/settings/${kind}/test`, draft);
}

export async function deleteAiSettings(kind: AiKind): Promise<void> {
	await apiDelete(`ai/settings/${kind}`);
}
