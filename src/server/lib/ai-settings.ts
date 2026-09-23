import {
	type AiKind,
	type AiRuntimeConfig,
	defaultAiSettings,
	type PublicAiSettings,
	sameAiDestination,
} from "../../lib/ai-settings";
import { currentKeyVersion, type Env, encryptionKey } from "../env";
import { createDb, type Db } from "./db/d1";
import { ApiError } from "./errors";
import { decryptToken, encryptToken, parseKeyBytes } from "./token-crypto";

type AiSettingsRow = {
	kind: AiKind;
	api_key_ciphertext: string;
	key_version: number;
	model: string;
	base_url: string;
	sdk_type: AiRuntimeConfig["sdkType"];
	auth_type: AiRuntimeConfig["authType"];
	updated_at: string;
};

async function readSettings(db: Db, kind: AiKind): Promise<AiSettingsRow | null> {
	return db.prepare("SELECT * FROM ai_settings WHERE kind = ?").bind(kind).first<AiSettingsRow>();
}

function publicSettings(row: AiSettingsRow): PublicAiSettings {
	return {
		kind: row.kind,
		model: row.model,
		baseURL: row.base_url,
		sdkType: row.sdk_type,
		authType: row.auth_type,
		hasApiKey: true,
		updatedAt: row.updated_at,
	};
}

function keyBytes(env: Env, version: number): Uint8Array {
	const secret = encryptionKey(env, version);
	if (!secret)
		throw new ApiError(500, "encryption_misconfigured", "AI key encryption is unavailable");
	return parseKeyBytes(secret);
}

export async function getPublicAiSettings(db: Db): Promise<PublicAiSettings[]> {
	const rows = await db.prepare("SELECT * FROM ai_settings").all<AiSettingsRow>();
	return (["summary", "judgment"] as const).map((kind) => {
		const row = rows.results.find((item) => item.kind === kind);
		return row ? publicSettings(row) : defaultAiSettings(kind);
	});
}

export async function loadAiConfig(env: Env, kind: AiKind): Promise<AiRuntimeConfig | null> {
	const row = await readSettings(createDb(env.DB), kind);
	if (!row) return null;
	const { hasApiKey: _, updatedAt: __, ...config } = publicSettings(row);
	return {
		...config,
		apiKey: await decryptToken(row.api_key_ciphertext, keyBytes(env, row.key_version)),
	};
}

function invalid(message: string): never {
	throw new ApiError(400, "validation_failed", message);
}

function baseURL(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return invalid("AI endpoint must be a public HTTPS URL");
	}
	const host = url.hostname.toLowerCase();
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!host.includes(".") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host.startsWith("[") ||
		/^(0|10|127|169\.254|192\.168)\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host)
	)
		invalid("AI endpoint must be a public HTTPS URL without credentials, query or fragment");
	return url.toString().replace(/\/+$/, "");
}

export async function resolveAiDraft(
	env: Env,
	db: Db,
	kind: AiKind,
	raw: unknown,
): Promise<AiRuntimeConfig> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("Invalid AI settings");
	const stored = await readSettings(db, kind);
	const defaults = stored ? publicSettings(stored) : defaultAiSettings(kind);
	const body = raw as Record<string, unknown>;
	const model = body.model === undefined ? defaults.model : body.model;
	const endpoint = body.baseURL === undefined ? defaults.baseURL : body.baseURL;
	const sdkType = body.sdkType === undefined ? defaults.sdkType : body.sdkType;
	const authType = body.authType === undefined ? defaults.authType : body.authType;
	const key = body.apiKey === undefined ? "" : body.apiKey;
	if (typeof model !== "string" || !model.trim() || model.length > 160 || /\p{Cc}/u.test(model))
		invalid("Enter a valid model name");
	if (typeof endpoint !== "string" || endpoint.length > 2048) invalid("Enter a valid AI endpoint");
	if (sdkType !== "openai" && sdkType !== "anthropic") invalid("Unsupported AI protocol");
	if (authType !== "apiKey" && authType !== "bearer") invalid("Unsupported AI authentication");
	if (typeof key !== "string" || key.length > 4096 || /[\s\p{Cc}]/u.test(key))
		invalid("Enter a valid API key");
	const config: Omit<AiRuntimeConfig, "apiKey"> = {
		kind,
		model: model.trim(),
		baseURL: baseURL(endpoint),
		sdkType,
		authType,
	};
	if (
		kind === "judgment" &&
		(config.baseURL !== "https://api.typesafe.ai" || sdkType !== "openai" || authType !== "apiKey")
	)
		invalid("Judgment uses the TypeSafe endpoint");
	if (key) return { ...config, apiKey: key };
	if (!stored || !sameAiDestination(config, defaults))
		invalid("Enter an API key for this destination");
	return {
		...config,
		apiKey: await decryptToken(stored.api_key_ciphertext, keyBytes(env, stored.key_version)),
	};
}

export async function saveAiSettings(
	env: Env,
	db: Db,
	config: AiRuntimeConfig,
): Promise<PublicAiSettings> {
	const version = currentKeyVersion(env);
	const encrypted = await encryptToken(config.apiKey, keyBytes(env, version));
	const updatedAt = new Date().toISOString();
	await db
		.prepare(`INSERT INTO ai_settings(kind, api_key_ciphertext, key_version, model, base_url, sdk_type, auth_type, updated_at)
		VALUES(?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(kind) DO UPDATE SET api_key_ciphertext=excluded.api_key_ciphertext, key_version=excluded.key_version,
		model=excluded.model, base_url=excluded.base_url, sdk_type=excluded.sdk_type, auth_type=excluded.auth_type, updated_at=excluded.updated_at`)
		.bind(
			config.kind,
			encrypted,
			version,
			config.model,
			config.baseURL,
			config.sdkType,
			config.authType,
			updatedAt,
		)
		.run();
	return {
		kind: config.kind,
		model: config.model,
		baseURL: config.baseURL,
		sdkType: config.sdkType,
		authType: config.authType,
		hasApiKey: true,
		updatedAt,
	};
}
