import type { Identity } from "./lib/access-identity";
import type { Db } from "./lib/db/d1";

export type AppVars = {
	db: Db;
	identity: Identity;
};

export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	ENVIRONMENT?: string;
	TOKEN_ENCRYPTION_KEY_CURRENT: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	CF_ACCESS_AUD?: string;
	GITHUB_API_BASE?: string;
	ACCESS_JWKS_URL?: string;
}

export type EnvMode = "development" | "test" | "production";

export function envMode(environment: string | undefined): EnvMode {
	if (environment === "development") {
		return "development";
	}
	if (environment === "test") {
		return "test";
	}
	return "production";
}

export function encryptionKey(env: Env, version: number): string | undefined {
	const name = `TOKEN_ENCRYPTION_KEY_V${version}`;
	if (!/^TOKEN_ENCRYPTION_KEY_V\d+$/.test(name)) {
		return undefined;
	}
	const value = (env as unknown as Record<string, unknown>)[name];
	if (typeof value !== "string" || value.length === 0) {
		return undefined;
	}
	return value;
}

export function currentKeyVersion(env: Env): number {
	if (!/^[1-9]\d*$/.test(env.TOKEN_ENCRYPTION_KEY_CURRENT)) {
		return Number.NaN;
	}
	return Number(env.TOKEN_ENCRYPTION_KEY_CURRENT);
}
