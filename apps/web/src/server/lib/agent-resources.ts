import {
	type AgentResource,
	createResourceSchema,
	listResourceSchema,
	type ResourceCollection,
	updateResourceSchema,
} from "../../lib/agent-resource";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";
import { createId } from "./id";

type Row = Omit<AgentResource, "payload"> & { payload: string };
const decode = (row: Row): AgentResource => ({
	...row,
	payload: JSON.parse(row.payload) as AgentResource["payload"],
});
const invalid = () => new ApiError(400, "validation_failed", "invalid resource");
export async function getResource(
	db: Db,
	account: string,
	collection: ResourceCollection,
	id: string,
) {
	const row = await db
		.prepare(
			"SELECT id,account_id,repository,type,status,source_version,payload,revision,created_at,updated_at FROM agent_resources WHERE account_id=? AND collection=? AND id=?",
		)
		.bind(account, collection, id)
		.first<Row>();
	return row ? decode(row) : null;
}
export async function listResources(
	db: Db,
	account: string,
	collection: ResourceCollection,
	input: unknown,
) {
	const parsed = listResourceSchema.safeParse(input);
	if (!parsed.success) throw invalid();
	const q = parsed.data;
	const clauses = ["account_id=?", "collection=?", "id>?"];
	const args: (string | number | null)[] = [account, collection, q.cursor ?? ""];
	for (const key of ["type", "status", "repository"] as const)
		if (q[key] !== undefined) {
			clauses.push(`${key} IS ?`);
			args.push(q[key]);
		}
	const result = await db
		.prepare(
			`SELECT id,account_id,repository,type,status,source_version,payload,revision,created_at,updated_at FROM agent_resources WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`,
		)
		.bind(...args, q.limit + 1)
		.all<Row>();
	const items = result.results.slice(0, q.limit).map(decode);
	return {
		account_id: account,
		items,
		nextCursor: result.results.length > q.limit ? (items.at(-1)?.id ?? null) : null,
	};
}
export async function createResource(
	db: Db,
	account: string,
	collection: ResourceCollection,
	input: unknown,
) {
	const parsed = createResourceSchema.safeParse(input);
	if (!parsed.success) throw invalid();
	const value = parsed.data;
	const id = value.id ?? createId();
	const now = new Date().toISOString();
	const result = await db
		.prepare(
			"INSERT INTO agent_resources(account_id,collection,id,repository,type,status,source_version,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,collection,id) DO NOTHING",
		)
		.bind(
			account,
			collection,
			id,
			value.repository,
			value.type,
			value.status,
			value.source_version,
			JSON.stringify(value.payload),
			now,
			now,
		)
		.run();
	if (!result.meta.changes) throw new ApiError(409, "resource_exists", "resource already exists");
	return { ...value, id, account_id: account, revision: 1, created_at: now, updated_at: now };
}
export async function updateResource(
	db: Db,
	account: string,
	collection: ResourceCollection,
	id: string,
	input: unknown,
) {
	const parsed = updateResourceSchema.safeParse(input);
	if (!parsed.success) throw invalid();
	const previous = await getResource(db, account, collection, id);
	if (!previous) throw new ApiError(404, "not_found", "resource not found");
	const item = {
		...previous,
		...parsed.data,
		revision: parsed.data.revision + 1,
		updated_at: new Date().toISOString(),
	};
	const result = await db
		.prepare(
			"UPDATE agent_resources SET repository=?,type=?,status=?,source_version=?,payload=?,revision=revision+1,updated_at=? WHERE account_id=? AND collection=? AND id=? AND revision=?",
		)
		.bind(
			item.repository,
			item.type,
			item.status,
			item.source_version,
			JSON.stringify(item.payload),
			item.updated_at,
			account,
			collection,
			id,
			parsed.data.revision,
		)
		.run();
	if (!result.meta.changes) throw new ApiError(409, "revision_conflict", "resource changed");
	return item;
}
export async function deleteResource(
	db: Db,
	account: string,
	collection: ResourceCollection,
	id: string,
	revision: number,
) {
	if (!Number.isSafeInteger(revision) || revision < 1) throw invalid();
	const result = await db
		.prepare(
			"DELETE FROM agent_resources WHERE account_id=? AND collection=? AND id=? AND revision=?",
		)
		.bind(account, collection, id, revision)
		.run();
	if (!result.meta.changes)
		throw new ApiError(
			(await getResource(db, account, collection, id)) ? 409 : 404,
			"revision_conflict",
			"resource missing or changed",
		);
}
