import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { openBrowser, performLogin } from "@nocoo/base-cli";
import { credentialSchema, homeDirectory, serviceUrl, writePrivateJson } from "./config.ts";

export async function login(
	baseUrl: string,
	options: {
		directory?: string;
		browser?: (url: string) => Promise<void>;
		transport?: typeof fetch;
		timeoutMs?: number;
		log?: (text: string) => void;
	} = {},
) {
	const origin = serviceUrl.parse(baseUrl).replace(/\/$/, "");
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	let code = "";
	let redirectUri = "";
	const result = await performLogin({
		apiUrl: origin,
		loginPath: "/authorize",
		tokenParam: "code",
		timeoutMs: options.timeoutMs ?? 180000,
		extraParams: {
			code_challenge: challenge,
			code_challenge_method: "S256",
			scopes: "observations:read agent:read agent:write",
		},
		onSaveToken: (value) => {
			code = value;
		},
		openBrowser: async (address) => {
			const url = new URL(address);
			redirectUri = url.searchParams.get("callback") ?? "";
			url.searchParams.delete("callback");
			url.searchParams.set("redirect_uri", redirectUri);
			options.log?.(`在浏览器中授权：${url}`);
			await (options.browser ?? openBrowser)(url.toString());
		},
	});
	if (!result.success || !code)
		throw new Error("Login was not completed. No credential was saved.");
	const response = await (options.transport ?? fetch)(`${origin}/api/v1/auth/exchange`, {
		method: "POST",
		redirect: "error",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) throw new Error(`Login exchange failed (${response.status}).`);
	const credential = credentialSchema.parse({
		...((await response.json()) as object),
		baseUrl: origin,
	});
	writePrivateJson(join(options.directory ?? homeDirectory(), "credentials.json"), credential);
	return { accountId: credential.account_id, expiresAt: credential.expires_at };
}
