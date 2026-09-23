export type AiKind = "summary" | "judgment";

export type AiRuntimeConfig = {
	kind: AiKind;
	apiKey: string;
	model: string;
	baseURL: string;
	sdkType: "openai" | "anthropic";
	authType: "apiKey" | "bearer";
};

export type PublicAiSettings = Omit<AiRuntimeConfig, "apiKey"> & {
	hasApiKey: boolean;
	updatedAt: string | null;
};

export type AiSettingsDraft = Omit<AiRuntimeConfig, "kind">;

export function defaultAiSettings(kind: AiKind): PublicAiSettings {
	return {
		kind,
		model: kind === "summary" ? "" : "jev-latest",
		baseURL: kind === "summary" ? "https://api.openai.com/v1" : "https://api.typesafe.ai",
		sdkType: "openai",
		authType: "apiKey",
		hasApiKey: false,
		updatedAt: null,
	};
}

export function sameAiDestination(
	a: Pick<AiRuntimeConfig, "baseURL" | "sdkType" | "authType">,
	b: Pick<AiRuntimeConfig, "baseURL" | "sdkType" | "authType">,
): boolean {
	return (
		a.baseURL.replace(/\/+$/, "") === b.baseURL.replace(/\/+$/, "") &&
		a.sdkType === b.sdkType &&
		a.authType === b.authType
	);
}
