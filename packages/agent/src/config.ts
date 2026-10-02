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
export const repairProfileSchema = z.strictObject({
	manager: z.enum(["npm", "bun"]),
	checks: z
		.array(z.string().regex(/^[a-zA-Z0-9:_-]+$/))
		.min(1)
		.max(10),
	files: z.array(z.string().min(1)).min(1).max(100),
	hooksPath: z.string().min(1),
});
const repairsSchema = z
	.strictObject({
		enabled: z.boolean().default(false),
		cron: z.string().default("0 * * * *"),
		timezone: z.string().default("Asia/Shanghai"),
		maxRounds: z.number().int().min(1).max(20).default(20),
		profiles: z
			.record(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), repairProfileSchema)
			.default({}),
		push: z.boolean().default(false),
		sandbox: z.strictObject({ image: z.string().min(1), registry: z.string().url() }).optional(),
	})
	.default({
		enabled: false,
		cron: "0 * * * *",
		timezone: "Asia/Shanghai",
		maxRounds: 20,
		profiles: {},
		push: false,
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
		watch: z
			.strictObject({
				intervalSeconds: z.number().int().min(30).max(86400).default(120),
			})
			.default({ intervalSeconds: 120 }),
		repairs: repairsSchema,
	})
	.superRefine((value, ctx) => {
		try {
			nextOccurrence(value.repairs.cron, value.repairs.timezone, "2026-01-01T00:00:00Z");
		} catch {
			ctx.addIssue({
				code: "custom",
				path: ["repairs", "cron"],
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
