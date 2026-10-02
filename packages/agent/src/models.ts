import type { Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { Config } from "./config.ts";

export function configuredModels(config: Config) {
	const models = createModels();
	for (const [id, provider] of Object.entries(config.providers)) {
		if (provider.api === "typesafe-systemone") continue;
		const entries = new Map<string, Model<string>>();
		for (const role of [config.roles.orchestrator, config.roles.executor]) {
			if (role.provider !== id) continue;
			entries.set(role.model, {
				id: role.model,
				name: role.model,
				provider: id,
				api: provider.api,
				baseUrl: provider.baseUrl,
				reasoning: role.thinkingLevel !== "off",
				input: ["text"],
				contextWindow: role.contextWindow,
				maxTokens: role.maxTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
		}
		const api =
			provider.api === "openai-completions"
				? openAICompletionsApi()
				: provider.api === "openai-responses"
					? openAIResponsesApi()
					: anthropicMessagesApi();
		models.setProvider(
			createProvider({
				id,
				baseUrl: provider.baseUrl,
				models: [...entries.values()],
				api,
				auth: {
					apiKey: {
						name: id,
						resolve: async () => ({ auth: { apiKey: provider.apiKey } }),
					},
				},
			}),
		);
	}
	return models;
}
