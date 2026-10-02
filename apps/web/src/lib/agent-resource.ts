import { z } from "zod";

export const resourceCollection = z.enum(["records", "reports", "jobs"]);
export type ResourceCollection = z.infer<typeof resourceCollection>;
export const resourceId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const payload = z
	.record(z.string(), z.json())
	.refine(
		(value) => new TextEncoder().encode(JSON.stringify(value)).length <= 64 * 1024,
		"payload exceeds 64 KiB",
	);
const fields = {
	repository: z
		.string()
		.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
		.max(200)
		.nullable(),
	type: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
	status: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
	source_version: z.string().max(200).nullable(),
	payload,
};
export const createResourceSchema = z
	.object({
		id: resourceId.optional(),
		...fields,
		repository: fields.repository.default(null),
		source_version: fields.source_version.default(null),
	})
	.strict();
export const updateResourceSchema = z
	.object(fields)
	.partial()
	.extend({ revision: z.number().int().positive() })
	.strict();
export const listResourceSchema = z
	.object({
		limit: z.coerce.number().int().min(1).max(100).default(50),
		cursor: resourceId.nullish(),
		type: fields.type.optional(),
		status: fields.status.optional(),
		repository: fields.repository.optional(),
	})
	.strict();
export type AgentResource = z.infer<typeof createResourceSchema> & {
	id: string;
	account_id: string;
	revision: number;
	created_at: string;
	updated_at: string;
};
