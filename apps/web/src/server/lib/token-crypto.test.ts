import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import {
	assertClassicPat,
	decryptToken,
	encryptToken,
	parseEnvelope,
	parseKeyBytes,
	tokenLast4,
} from "./token-crypto";

const ZERO_HEX = "0".repeat(64);
const PAT = `ghp_${"A".repeat(36)}`;

describe("token-crypto", () => {
	it("rejects non-classic PATs", () => {
		expect(() => assertClassicPat("github_pat_abc")).toThrow(ApiError);
		expect(() => assertClassicPat("ghp_short")).toThrow(ApiError);
		assertClassicPat(PAT);
		expect(tokenLast4(PAT)).toBe("AAAA");
	});

	it("round-trips AES-GCM and splits ct from the 16-byte tag", async () => {
		const key = parseKeyBytes(ZERO_HEX);
		const first = await encryptToken(PAT, key);
		const second = await encryptToken(PAT, key);
		expect(first).not.toBe(second);
		const env = parseEnvelope(first);
		expect(env.v).toBe(1);
		const ct = atob(env.ct);
		const tag = atob(env.tag);
		expect(tag.length).toBe(16);
		expect(ct.includes(tag)).toBe(false);
		expect(await decryptToken(first, key)).toBe(PAT);
	});

	it("accepts 32-byte base64 keys and fails the wrong key", async () => {
		const raw = new Uint8Array(32);
		raw.fill(7);
		let bin = "";
		for (const b of raw) {
			bin += String.fromCharCode(b);
		}
		const key = parseKeyBytes(btoa(bin));
		const envelope = await encryptToken(PAT, key);
		await expect(decryptToken(envelope, parseKeyBytes(ZERO_HEX))).rejects.toBeInstanceOf(ApiError);
		expect(() => parseKeyBytes("nope")).toThrow(ApiError);
		expect(() => parseKeyBytes(btoa("short"))).toThrow(ApiError);
		await expect(decryptToken("not-json", key)).rejects.toBeInstanceOf(ApiError);
		expect(() => parseEnvelope("{}")).toThrow(ApiError);
	});
});
