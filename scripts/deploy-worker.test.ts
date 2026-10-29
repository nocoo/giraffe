import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deployWorker } from "./deploy-worker";

const environment = {
	GITHUB_ACTIONS: "true",
	GITHUB_REPOSITORY: "nocoo/giraffe",
	CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
	CLOUDFLARE_API_TOKEN: "fake-deployment-token",
};
const queueId = "b".repeat(32);
const consumerId = "c".repeat(32);
const consumer = { consumer_id: consumerId, type: "worker", script: "giraffe" };
const queue = (consumers: unknown[]) => ({
	queue_id: queueId,
	queue_name: "giraffe-factory",
	consumers,
});
const reply = (result: unknown) => Response.json({ success: true, result });

afterEach(() => vi.restoreAllMocks());

describe("collection trigger retirement deployment", () => {
	it("explicitly clears cron schedules and uses the guarded deployment script", () => {
		expect(readFileSync("wrangler.toml", "utf8")).toMatch(/\[triggers\]\s+crons = \[\]/);
		expect(readFileSync(".github/workflows/release.yml", "utf8")).toContain(
			'deploy-script: "bun run scripts/deploy-worker.ts"',
		);
	});
	it.each([
		{},
		{ ...environment, GITHUB_ACTIONS: "false" },
		{ ...environment, GITHUB_REPOSITORY: "nocoo/other" },
		{ ...environment, CLOUDFLARE_API_TOKEN: "" },
		{ ...environment, CLOUDFLARE_ACCOUNT_ID: "../other" },
	])("refuses invalid deployment context before network or deployment", async (env) => {
		const request = vi.fn();
		const deploy = vi.fn();
		await expect(deployWorker(env, request, deploy)).rejects.toThrow("deployment context");
		expect(request).not.toHaveBeenCalled();
		expect(deploy).not.toHaveBeenCalled();
	});
	it.each([
		consumer,
		{ consumer_id: consumerId, type: "worker", service: "giraffe", environment: "production" },
	])("removes only the production worker consumer before deployment", async (target) => {
		const other = { ...consumer, consumer_id: "d".repeat(32), script: "other" };
		const staging = { ...target, consumer_id: "e".repeat(32), environment: "staging" };
		const request = vi
			.fn()
			.mockResolvedValueOnce(reply([queue([target, other, staging])]))
			.mockResolvedValueOnce(reply(null))
			.mockResolvedValueOnce(reply([queue([other, staging])]))
			.mockResolvedValueOnce(reply({ schedules: [] }));
		const deploy = vi.fn().mockImplementation(async () => {
			expect(request).toHaveBeenCalledTimes(2);
		});
		await deployWorker(environment, request, deploy);
		expect(deploy).toHaveBeenCalledOnce();
		expect(request.mock.calls[1]?.[0]).toBe(
			`https://api.cloudflare.com/client/v4/accounts/${environment.CLOUDFLARE_ACCOUNT_ID}/queues/${queueId}/consumers/${consumerId}`,
		);
		expect(request.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
		expect(request.mock.calls[3]?.[0]).toContain("/workers/scripts/giraffe/schedules");
	});
	it.each([{ queues: [] }, { queues: [queue([])] }])(
		"is idempotent when collection consumers are absent",
		async ({ queues }) => {
			const request = vi
				.fn()
				.mockResolvedValueOnce(reply(queues))
				.mockResolvedValueOnce(reply(queues))
				.mockResolvedValueOnce(reply({ schedules: [] }));
			const deploy = vi.fn().mockResolvedValue(undefined);
			await deployWorker(environment, request, deploy);
			expect(deploy).toHaveBeenCalledOnce();
			expect(request.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
		},
	);
	it("accepts a successful consumer deletion without a result field", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(reply([queue([consumer])]))
			.mockResolvedValueOnce(Response.json({ success: true, errors: [], messages: [] }))
			.mockResolvedValueOnce(reply([queue([])]))
			.mockResolvedValueOnce(reply({ schedules: [] }));
		const deploy = vi.fn().mockResolvedValue(undefined);
		await deployWorker(environment, request, deploy);
		expect(deploy).toHaveBeenCalledOnce();
	});
	it.each([
		new Response("secret-upstream-error", { status: 403 }),
		Response.json({ success: false, errors: ["secret-upstream-error"] }),
		new Response("secret-upstream-error"),
		reply([queue([{ ...consumer, consumer_id: "../other" }])]),
	])("fails closed on API errors or invalid responses", async (response) => {
		const request = vi.fn().mockResolvedValue(response);
		const deploy = vi.fn();
		await expect(deployWorker(environment, request, deploy)).rejects.toThrow("Cloudflare");
		expect(deploy).not.toHaveBeenCalled();
	});
	it("sanitizes transport errors", async () => {
		const request = vi.fn().mockRejectedValue(new Error("secret-upstream-error"));
		await expect(deployWorker(environment, request, vi.fn())).rejects.toThrow(
			"Cloudflare request failed",
		);
	});
	it("stops when deployment fails", async () => {
		const request = vi.fn().mockResolvedValueOnce(reply([]));
		const deploy = vi.fn().mockRejectedValue(new Error("deploy failed"));
		await expect(deployWorker(environment, request, deploy)).rejects.toThrow("deploy failed");
		expect(request).toHaveBeenCalledOnce();
	});
	it.each([
		{ queues: [queue([consumer])], schedules: [] },
		{ queues: [], schedules: [{ cron: "* * * * *" }] },
	])("fails verification if any retired trigger remains", async ({ queues, schedules }) => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(reply([]))
			.mockResolvedValueOnce(reply(queues))
			.mockResolvedValueOnce(reply({ schedules }));
		await expect(deployWorker(environment, request, vi.fn())).rejects.toThrow(
			"Collection triggers remain",
		);
	});
});
