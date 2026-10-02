import { type Env, envMode } from "../env";
import { ACCESS_AUD, ACCESS_TEAM_DOMAIN } from "../lib/access-config";
import { type Identity, identityFromClaims } from "../lib/access-identity";
import { ApiError } from "../lib/errors";

const STUB: Identity = { email: "dev@local", name: "dev" };

export function accessBypass(env: Env): boolean {
	return (
		envMode(env.ENVIRONMENT) === "development" &&
		Boolean(env.GITHUB_API_BASE) &&
		!env.CF_ACCESS_TEAM_DOMAIN &&
		!env.CF_ACCESS_AUD
	);
}

function b64urlToBytes(value: string): Uint8Array {
	const padded =
		value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

async function verifyJwt(
	token: string,
	jwks: { keys: Array<JsonWebKey & { kid?: string }> },
	iss: string,
	aud: string,
): Promise<Identity> {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
		throw new ApiError(401, "access_unauthorized", "bad token");
	}
	let header: { alg?: string; kid?: string };
	let payload: {
		iss?: string;
		aud?: string | string[];
		exp?: number;
		nbf?: number;
		email?: string;
		name?: string;
	};
	try {
		header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]))) as typeof header;
		payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))) as typeof payload;
	} catch {
		throw new ApiError(401, "access_unauthorized", "bad token");
	}
	if (header.alg !== "RS256") {
		throw new ApiError(401, "access_unauthorized", "bad alg");
	}
	const jwk = header.kid ? jwks.keys.find((key) => key.kid === header.kid) : jwks.keys[0];
	if (!jwk) {
		throw new ApiError(401, "access_unauthorized", "no jwk");
	}
	let ok = false;
	try {
		const key = await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			b64urlToBytes(parts[2]),
			dataBytes(parts),
		);
	} catch {
		throw new ApiError(401, "access_unauthorized", "bad token");
	}
	if (!ok) {
		throw new ApiError(401, "access_unauthorized", "bad signature");
	}
	if (payload.iss !== iss) {
		throw new ApiError(401, "access_unauthorized", "bad iss");
	}
	const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
	if (!audOk) {
		throw new ApiError(401, "access_unauthorized", "bad aud");
	}
	const now = Math.floor(Date.now() / 1000);
	if (typeof payload.exp !== "number" || payload.exp <= now) {
		throw new ApiError(401, "access_unauthorized", "expired");
	}
	if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now)) {
		throw new ApiError(401, "access_unauthorized", "not yet valid");
	}
	try {
		return identityFromClaims(payload.email, payload.name);
	} catch {
		throw new ApiError(401, "access_unauthorized", "missing email");
	}
}

function dataBytes(parts: string[]): Uint8Array {
	return new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function resolveIdentity(
	request: Request,
	env: Env,
	fetchImpl: FetchImpl = fetch,
): Promise<Identity> {
	if (accessBypass(env)) {
		return STUB;
	}
	const mode = envMode(env.ENVIRONMENT);
	let iss: string;
	let aud: string;
	let jwksUrl: string;
	if (mode === "test") {
		if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD || !env.ACCESS_JWKS_URL) {
			throw new ApiError(500, "access_misconfigured", "access env missing");
		}
		iss = env.CF_ACCESS_TEAM_DOMAIN;
		aud = env.CF_ACCESS_AUD;
		jwksUrl = env.ACCESS_JWKS_URL;
	} else {
		iss = env.CF_ACCESS_TEAM_DOMAIN || ACCESS_TEAM_DOMAIN;
		aud = env.CF_ACCESS_AUD || ACCESS_AUD;
		jwksUrl = `${iss.replace(/\/$/, "")}/cdn-cgi/access/certs`;
	}
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) {
		throw new ApiError(401, "access_unauthorized", "missing jwt");
	}
	const res = await fetchImpl(jwksUrl);
	if (!res.ok) {
		throw new ApiError(401, "access_unauthorized", "jwks failed");
	}
	const jwks = (await res.json()) as { keys: JsonWebKey[] };
	return verifyJwt(token, jwks, iss, aud);
}
