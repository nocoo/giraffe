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

export const apiRedirectUriSchema = z
	.string()
	.max(100)
	.refine((value) => {
		const match = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})\/callback$/.exec(value);
		return match !== null && match[0] === value && Number(match[1]) <= 65535;
	});

export const createAuthorizationCodeSchema = createApiTokenSchema.extend({
	redirectUri: apiRedirectUriSchema,
	state: z
		.string()
		.min(1)
		.max(512)
		.refine((value) => !/\p{Cc}/u.test(value)),
	codeChallenge: z
		.string()
		.length(43)
		.regex(/^[A-Za-z0-9_-]{43}$/),
});

export const exchangeAuthorizationCodeSchema = z.strictObject({
	code: z
		.string()
		.length(56)
		.regex(/^giraffe_code_[A-Za-z0-9_-]{43}$/),
	codeVerifier: z
		.string()
		.min(43)
		.max(128)
		.refine((value) => !/[^A-Za-z0-9._~-]/.test(value)),
	redirectUri: apiRedirectUriSchema,
});

export type ApiScope = z.infer<typeof apiScopeSchema>;
export type CreateApiTokenInput = z.input<typeof createApiTokenSchema>;
export type UpdateApiTokenInput = z.input<typeof updateApiTokenSchema>;
export type CreateAuthorizationCodeInput = z.input<typeof createAuthorizationCodeSchema>;
export type ExchangeAuthorizationCodeInput = z.input<typeof exchangeAuthorizationCodeSchema>;

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

export type AuthorizationCode = {
	code: string;
	redirectUri: string;
	state: string;
	expiresAt: string;
};
