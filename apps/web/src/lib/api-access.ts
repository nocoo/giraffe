import { z } from "zod";

export const API_SCOPES = [
	"observations:read",
	"agent:read",
	"agent:write",
	"app:read",
	"app:write",
] as const;

export const apiScopeSchema = z.enum(API_SCOPES);
export const apiScopesSchema = z
	.array(apiScopeSchema)
	.min(1)
	.max(API_SCOPES.length)
	.refine((scopes) => new Set(scopes).size === scopes.length);

const labelSchema = z
	.string()
	.max(120)
	.refine((value) => !/\p{Cc}/u.test(value))
	.trim()
	.min(1);
const creatorSchema = z
	.string()
	.max(320)
	.refine((value) => !/\p{Cc}/u.test(value))
	.trim()
	.min(1);

export const createApiTokenSchema = z.strictObject({
	accountId: z.string().min(1).max(128),
	label: labelSchema,
	scopes: apiScopesSchema,
	expiresInDays: z.number().int().min(1).max(90).default(30),
	creator: creatorSchema,
});

export const updateApiTokenSchema = z
	.strictObject({ label: labelSchema.optional(), scopes: apiScopesSchema.optional() })
	.refine((input) => input.label !== undefined || input.scopes !== undefined);

export type ApiScope = z.infer<typeof apiScopeSchema>;
export type CreateApiTokenInput = z.input<typeof createApiTokenSchema>;
export type UpdateApiTokenInput = z.input<typeof updateApiTokenSchema>;

export type ApiToken = {
	id: string;
	account_id: string;
	label: string;
	scopes: ApiScope[];
	creator: string;
	created_at: string;
	expires_at: string;
	revoked_at: string | null;
	last_used_at: string | null;
};

export type CreatedApiToken = ApiToken & { token: string };
export type ApiTokenPrincipal = {
	id: string;
	accountId: string;
	scopes: ApiScope[];
	expiresAt: string;
};
