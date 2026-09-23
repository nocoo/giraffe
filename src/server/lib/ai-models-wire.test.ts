import { afterEach, expect, it, vi } from "vitest";
import { defaultAiSettings } from "../../lib/ai-settings";
import { testAiConnection } from "./ai-models";

afterEach(() => vi.unstubAllGlobals());
it("sends the connection probe through the actual TypeSafe TypeScript SDK", async () => {
	const mock = vi.fn().mockResolvedValue(
		Response.json({
			model: "jev-latest",
			answers: {
				connected: {
					type: "choice",
					choice: "yes",
					confidence: 1,
					probabilities: { yes: 1, no: 0 },
				},
			},
			usage: {},
		}),
	);
	vi.stubGlobal("fetch", mock);
	await testAiConnection({ ...defaultAiSettings("judgment"), apiKey: "fake-unit-key" });
	expect(mock).toHaveBeenCalledTimes(1);
	expect(String(mock.mock.calls[0]?.[0])).toBe("https://api.typesafe.ai/v1/systemone");
	const init = mock.mock.calls[0]?.[1] as RequestInit;
	expect(JSON.parse(init.body as string)).toMatchObject({
		model: "jev-latest",
		state: { connected: true },
	});
});
it("uses next-ai with the actual OpenAI and Anthropic SDK transports", async () => {
	const mock = vi.fn().mockImplementation(async (url: string) =>
		Response.json(
			url.endsWith("/responses")
				? {
						id: "resp_test",
						object: "response",
						created_at: 1,
						model: "unit",
						status: "completed",
						output: [
							{
								type: "message",
								id: "msg_test",
								role: "assistant",
								content: [{ type: "output_text", text: "OK", annotations: [] }],
							},
						],
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					}
				: {
						id: "msg_test",
						type: "message",
						role: "assistant",
						model: "unit",
						content: [{ type: "text", text: "OK" }],
						stop_reason: "end_turn",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
		),
	);
	vi.stubGlobal("fetch", mock);
	for (const sdkType of ["openai", "anthropic"] as const)
		await testAiConnection({
			...defaultAiSettings("summary"),
			baseURL: "https://models.example/v1",
			model: "unit",
			sdkType,
			apiKey: "fake-unit-key",
		});
	expect(mock).toHaveBeenCalledTimes(2);
	expect(String(mock.mock.calls[0]?.[0])).toBe("https://models.example/v1/responses");
	expect(String(mock.mock.calls[1]?.[0])).toBe("https://models.example/v1/messages");
});
