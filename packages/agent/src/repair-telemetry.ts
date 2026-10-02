import { ApiError, type Collection, type GiraffeClient } from "./client.ts";
import type { CronStatus, RepairProgress } from "./repair-contracts.ts";

export function repairTelemetry(client: GiraffeClient) {
	async function upsert(
		collection: Collection,
		id: string,
		type: string,
		payload: Record<string, unknown>,
		status: string,
		repository: string | null,
	) {
		const existing = await client.get(collection, id);
		if (
			existing &&
			typeof existing.payload.sequence === "number" &&
			typeof payload.sequence === "number" &&
			existing.payload.sequence > payload.sequence
		)
			return;
		const input = { type, status, repository, source_version: null, payload };
		if (existing) await client.update(collection, existing, input);
		else await client.create(collection, { id, ...input });
	}
	return {
		async progress(value: RepairProgress) {
			await upsert("jobs", value.id, "dependency-repair", value, value.stage, value.repository);
		},
		async cron(value: CronStatus) {
			await upsert("records", "repair-cron", "repair-cron", value, value.state, null);
		},
		async paused(): Promise<boolean> {
			try {
				return (await client.get("records", "repair-control"))?.payload.paused === true;
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return false;
				throw error;
			}
		},
	};
}
