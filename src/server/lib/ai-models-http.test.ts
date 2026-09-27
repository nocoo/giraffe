import { afterEach, expect, it, vi } from "vitest";
import { input, report } from "../../../tests/fixtures/ai-review";
import { defaultAiSettings } from "../../lib/ai-settings";
import { summarizeRepository } from "./ai-models";

afterEach(() => vi.unstubAllGlobals());

it("sends the report schema through the installed SDK and validates the actual Responses wire format", async () => {
	let calls = 0;
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		calls++;
		expect(String(url)).toBe("https://models.example.test/v1/responses");
		const body = JSON.parse(String(init.body));
		expect(body.text.format).toMatchObject({
			type: "json_schema",
			strict: true,
			schema: { type: "object", additionalProperties: false },
		});
		expect(body.text.format.schema.required).toContain("delivery");
		expect(body.text.format.schema.properties.security.properties.status.enum).not.toContain(
			"healthy",
		);
		return Response.json({
			id: "resp_fixture",
			created_at: 1,
			model: "fixture",
			object: "response",
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg_fixture",
					role: "assistant",
					status: "completed",
					content: [
						{
							type: "output_text",
							text: JSON.stringify({ ...report(), limitations: ["Missing optional alerts"] }),
							annotations: [],
						},
					],
				},
			],
			usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
		});
	});
	const source = input();
	source.coverage.alerts.status = "unavailable";
	expect(
		await summarizeRepository(
			{
				...defaultAiSettings("summary"),
				model: "fixture",
				apiKey: "fake",
				baseURL: "https://models.example.test/v1",
			},
			source,
			null,
		),
	).toEqual({ ...report(), limitations: ["Missing optional alerts"] });
	expect(calls).toBe(1);
});

it.each([400, 401, 429, 503])(
	"classifies HTTP %s without exposing upstream bodies",
	async (status) => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return Response.json(
				{
					error: {
						message: "secret provider content",
						type: "invalid_request_error",
						code: "test",
					},
				},
				{ status },
			);
		});
		await expect(
			summarizeRepository(
				{
					...defaultAiSettings("summary"),
					model: "fixture",
					apiKey: "fake",
					baseURL: "https://models.example.test/v1",
				},
				input(),
				null,
			),
		).rejects.toMatchObject({
			code:
				status === 400
					? "ai_request_rejected"
					: status === 401
						? "ai_auth_failed"
						: status === 429
							? "ai_rate_limited"
							: "ai_provider_failed",
			diagnostic: { httpStatus: status },
		});
		expect(calls).toBe(status === 429 || status === 503 ? 2 : 1);
	},
);
