import type { Env } from "../env";
import { dueAssessments, executeAssessment } from "./ai-assessment";
import { createDb } from "./db/d1";
import { dueRuns } from "./db/factory-runs";
import { executeRunPage } from "./factory-execute";
import { pruneFactory } from "./factory-retention";

export async function enqueueRun(
	env: Env,
	id: string,
	at = new Date().toISOString(),
): Promise<void> {
	const delay = Math.min(43200, Math.max(0, Math.ceil((Date.parse(at) - Date.now()) / 1000)));
	await env.FACTORY_QUEUE.send({ id }, { delaySeconds: delay });
}
export async function consumeFactory(batch: MessageBatch<unknown>, env: Env): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;
		const review = body && typeof body === "object" && "reviewId" in body;
		const id =
			body && typeof body === "object"
				? review
					? body.reviewId
					: "id" in body
						? body.id
						: null
				: null;
		if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) {
			message.ack();
			continue;
		}
		try {
			const next = review ? await executeAssessment(env, id) : await executeRunPage(env, id);
			if (next) {
				if (review)
					await env.FACTORY_QUEUE.send(
						{ reviewId: id },
						{
							delaySeconds: Math.min(
								43200,
								Math.max(0, Math.ceil((Date.parse(next) - Date.now()) / 1000)),
							),
						},
					);
				else await enqueueRun(env, id, next);
			}
			message.ack();
		} catch {
			message.retry({ delaySeconds: 120 });
		}
	}
}
/** D1 is the durable outbox: missing messages and expired leases are redispatched every minute. */
export async function continueFactory(env: Env): Promise<void> {
	const ids = await dueRuns(createDb(env.DB), new Date().toISOString());
	for (const id of ids) await enqueueRun(env, id);
	for (const reviewId of await dueAssessments(createDb(env.DB), new Date().toISOString()))
		await env.FACTORY_QUEUE.send({ reviewId });
	await pruneFactory(createDb(env.DB), new Date().toISOString());
}
