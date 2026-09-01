import { ApiError } from "./errors";

const CLASSIC_PAT = /^ghp_[A-Za-z0-9]{36}$/;

export type TokenEnvelope = {
	v: 1;
	iv: string;
	ct: string;
	tag: string;
};

export function assertClassicPat(token: string): void {
	if (!CLASSIC_PAT.test(token)) {
		throw new ApiError(400, "validation_failed", "classic PAT required");
	}
}

export function tokenLast4(token: string): string {
	return token.slice(-4);
}

export function parseKeyBytes(secret: string): Uint8Array {
	if (/^[0-9a-fA-F]{64}$/.test(secret)) {
		const out = new Uint8Array(32);
		for (let i = 0; i < 32; i += 1) {
			const slice = secret.slice(i * 2, i * 2 + 2);
			out[i] = Number.parseInt(slice, 16);
		}
		return out;
	}
	try {
		const bin = atob(secret);
		if (bin.length !== 32) {
			throw new Error("bad length");
		}
		const out = new Uint8Array(32);
		for (let i = 0; i < 32; i += 1) {
			out[i] = bin.charCodeAt(i);
		}
		return out;
	} catch {
		throw new ApiError(500, "encryption_misconfigured", "key must be 32 bytes");
	}
}

function b64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) {
		s += String.fromCharCode(b);
	}
	return btoa(s);
}

function unb64(value: string): Uint8Array {
	const bin = atob(value);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

export async function encryptToken(token: string, keyBytes: Uint8Array): Promise<string> {
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const packed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token)),
	);
	const tag = packed.slice(packed.length - 16);
	const ct = packed.slice(0, packed.length - 16);
	const envelope: TokenEnvelope = { v: 1, iv: b64(iv), ct: b64(ct), tag: b64(tag) };
	return JSON.stringify(envelope);
}

export async function decryptToken(envelopeJson: string, keyBytes: Uint8Array): Promise<string> {
	let envelope: TokenEnvelope;
	try {
		envelope = JSON.parse(envelopeJson) as TokenEnvelope;
	} catch {
		throw new ApiError(500, "encryption_misconfigured", "invalid envelope");
	}
	const iv = unb64(envelope.iv);
	const ct = unb64(envelope.ct);
	const tag = unb64(envelope.tag);
	const packed = new Uint8Array(ct.length + tag.length);
	packed.set(ct);
	packed.set(tag, ct.length);
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
	try {
		const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, packed);
		return new TextDecoder().decode(plain);
	} catch {
		throw new ApiError(500, "encryption_misconfigured", "decrypt failed");
	}
}

export function parseEnvelope(envelopeJson: string): TokenEnvelope {
	const parsed = JSON.parse(envelopeJson) as TokenEnvelope;
	if (
		parsed.v !== 1 ||
		typeof parsed.iv !== "string" ||
		typeof parsed.ct !== "string" ||
		typeof parsed.tag !== "string"
	) {
		throw new ApiError(500, "encryption_misconfigured", "invalid envelope");
	}
	return parsed;
}
