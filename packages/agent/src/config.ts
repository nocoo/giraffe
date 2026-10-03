import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { nextOccurrence } from "./cron.ts";

export const homeDirectory = () => join(homedir(), ".config", "giraffe");
export const serviceUrl = z
	.string()
	.url()
	.refine((value) => {
		const url = new URL(value);
		return (
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			(url.protocol === "https:" ||
				(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
		);
	}, "Use HTTPS or a loopback HTTP endpoint without URL credentials");
const providerSchema = z.strictObject({
	api: z.enum([
		"openai-completions",
		"openai-responses",
		"anthropic-messages",
		"typesafe-systemone",
	]),
	baseUrl: serviceUrl,
	apiKey: z.string().trim().min(1),
});
const roleSchema = z.strictObject({
	provider: z.string().min(1),
	model: z.string().min(1),
	contextWindow: z.number().int().min(8192).default(128000),
	maxTokens: z.number().int().min(512).max(32000).default(4096),
	thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high"]).default("off"),
});
const workSchema = z
	.strictObject({
		cron: z.string().default("0 * * * *"),
		timezone: z.string().default("Asia/Shanghai"),
		registry: serviceUrl.default("https://mirrors.tencent.com/npm/"),
	})
	.default({
		cron: "0 * * * *",
		timezone: "Asia/Shanghai",
		registry: "https://mirrors.tencent.com/npm/",
	});
export const configSchema = z
	.strictObject({
		providers: z.record(z.string(), providerSchema),
		roles: z.strictObject({
			orchestrator: roleSchema,
			decision: roleSchema,
			executor: roleSchema,
		}),
		service: z
			.strictObject({ baseUrl: serviceUrl })
			.default({ baseUrl: "https://giraffe.hexly.ai" }),
		work: workSchema,
	})
	.superRefine((value, ctx) => {
		try {
			nextOccurrence(value.work.cron, value.work.timezone, "2026-01-01T00:00:00Z");
		} catch {
			ctx.addIssue({
				code: "custom",
				path: ["work", "cron"],
				message: "Invalid cron or timezone",
			});
		}
		for (const [name, role] of Object.entries(value.roles)) {
			const provider = value.providers[role.provider];
			if (
				!provider ||
				(name === "decision") !== (provider.api === "typesafe-systemone") ||
				role.maxTokens >= role.contextWindow
			) {
				ctx.addIssue({
					code: "custom",
					path: ["roles", name],
					message: "Invalid provider or token limits for role",
				});
			}
		}
	});
export type Config = z.infer<typeof configSchema>;

export function readConfig(directory = homeDirectory()): Config {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
	} catch {
		throw new Error(
			`Cannot read ${join(directory, "config.json")}. Configure providers and roles first.`,
		);
	}
	const parsed = configSchema.safeParse(value);
	if (!parsed.success)
		throw new Error(
			`Invalid Giraffe configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
		);
	return parsed.data;
}

export const credentialSchema = z.strictObject({
	baseUrl: serviceUrl,
	token: z.string().min(1),
	account_id: z.string().min(1),
	expires_at: z.string().datetime({ offset: true }),
	scopes: z.array(z.string()),
});
export type Credential = z.infer<typeof credentialSchema>;

export function readCredential(directory = homeDirectory()): Credential {
	try {
		const credential = credentialSchema.parse(
			JSON.parse(readFileSync(join(directory, "credentials.json"), "utf8")),
		);
		if (Date.parse(credential.expires_at) <= Date.now()) throw new Error("Expired");
		return credential;
	} catch {
		throw new Error("Run giraffe login to authorize this machine.");
	}
}

export function writePrivateJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	chmodSync(dirname(file), 0o700);
	const temporary = `${file}.${randomUUID()}.tmp`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
	} finally {
		closeSync(descriptor);
	}
	try {
		renameSync(temporary, file);
	} catch (error) {
		unlinkSync(temporary);
		throw error;
	}
}
