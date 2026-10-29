import { z } from "zod";

const cloudflareId = z.string().regex(/^[a-f0-9]{32}$/);
const queuesSchema = z.array(
	z.object({
		queue_id: cloudflareId,
		queue_name: z.string(),
		consumers: z.array(
			z.object({
				consumer_id: cloudflareId,
				type: z.string(),
				script: z.string().optional(),
				service: z.string().optional(),
				environment: z.string().optional(),
			}),
		),
	}),
);
const schedulesSchema = z.object({ schedules: z.array(z.object({ cron: z.string() })) });

export async function deployWorker(
	environment: Record<string, string | undefined> = process.env,
	request: (url: string, init: RequestInit) => Promise<Response> = fetch,
	deploy = async () => {
		const process = Bun.spawn(["node_modules/.bin/wrangler", "deploy"], {
			stdout: "inherit",
			stderr: "inherit",
		});
		if ((await process.exited) !== 0) throw new Error("Worker deployment failed");
	},
): Promise<void> {
	const account = environment.CLOUDFLARE_ACCOUNT_ID;
	const token = environment.CLOUDFLARE_API_TOKEN;
	if (
		environment.GITHUB_ACTIONS !== "true" ||
		environment.GITHUB_REPOSITORY !== "nocoo/giraffe" ||
		!cloudflareId.safeParse(account).success ||
		!token
	) {
		throw new Error("Invalid production deployment context");
	}
	async function api(path: string, method = "GET"): Promise<unknown> {
		let response: Response;
		try {
			response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(30_000),
			});
		} catch {
			throw new Error("Cloudflare request failed");
		}
		if (!response.ok) throw new Error(`Cloudflare request failed (${response.status})`);
		const body = z
			.object({ success: z.literal(true), result: z.unknown().optional() })
			.safeParse(await response.json().catch(() => null));
		if (!body.success) throw new Error("Invalid Cloudflare response");
		return body.data.result;
	}
	async function consumers() {
		const queues = queuesSchema.safeParse(await api("/queues?name=giraffe-factory"));
		if (!queues.success) throw new Error("Invalid Cloudflare queue response");
		return queues.data
			.filter((queue) => queue.queue_name === "giraffe-factory")
			.flatMap((queue) =>
				queue.consumers
					.filter(
						(consumer) =>
							consumer.type === "worker" &&
							(consumer.script === "giraffe" || consumer.service === "giraffe") &&
							(!consumer.environment || consumer.environment === "production"),
					)
					.map((consumer) => ({ queue: queue.queue_id, consumer: consumer.consumer_id })),
			);
	}
	for (const target of await consumers()) {
		await api(`/queues/${target.queue}/consumers/${target.consumer}`, "DELETE");
	}
	await deploy();
	const remainingConsumers = await consumers();
	const schedules = schedulesSchema.safeParse(await api("/workers/scripts/giraffe/schedules"));
	if (!schedules.success) throw new Error("Invalid Cloudflare schedules response");
	if (
		remainingConsumers.length ||
		schedules.data.schedules.length !== 1 ||
		schedules.data.schedules[0]?.cron !== "0 19 * * *"
	) {
		throw new Error("Invalid unified refresh triggers after deployment");
	}
}

if (import.meta.main) await deployWorker();
