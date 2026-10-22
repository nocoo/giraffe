import { z } from "zod";
import { type AgentResource, resourceId } from "./agent-resource";

export const GITHUB_DAILY_MAX_BYTES = 65_536;
const time = z.string().max(128).datetime({ offset: true });
const nonblank = (max: number) =>
	z
		.string()
		.max(max)
		.refine((value) => value.trim().length > 0);
const httpsUrl = z
	.string()
	.max(2048)
	.url()
	.refine((value) => {
		try {
			const url = new URL(value);
			return url.protocol === "https:" && !url.username && !url.password;
		} catch {
			return false;
		}
	});

function instant(at: string) {
	const utc = at.endsWith("Z");
	const zone = at.slice(-6);
	const offset = utc
		? 0
		: (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4))) * 60000 * (zone[0] === "+" ? 1 : -1);
	return {
		second: Date.parse(`${at.slice(0, 19)}Z`) - offset,
		fraction: at[19] === "." ? at.slice(20, utc ? -1 : -6).replace(/0+$/, "") : "",
	};
}
export function compareGeneratedAt(left: string, right: string): number {
	const leftInstant = instant(left),
		rightInstant = instant(right);
	return (
		leftInstant.second - rightInstant.second ||
		(leftInstant.fraction === rightInstant.fraction
			? 0
			: leftInstant.fraction < rightInstant.fraction
				? -1
				: 1)
	);
}

export const githubDailySchema = z
	.strictObject({
		date: z.iso.date(),
		window: z
			.strictObject({ since: time, until: time })
			.refine((value) => compareGeneratedAt(value.since, value.until) <= 0),
		refreshRunId: resourceId,
		headline: nonblank(300),
		sections: z
			.array(
				z.strictObject({
					title: nonblank(200),
					markdown: z.string().max(12000),
					items: z
						.array(
							z.strictObject({
								repo: z
									.string()
									.max(200)
									.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
									.nullable(),
								kind: nonblank(40),
								url: httpsUrl,
								severity: nonblank(40),
							}),
						)
						.max(50),
				}),
			)
			.max(12),
		comparisons: z.strictObject({ vsYesterday: z.string().max(4000), vs7d: z.string().max(4000) }),
		links: z.strictObject({ xray: httpsUrl }),
		generatedAt: time,
		sources: z
			.array(
				z.strictObject({
					resource: nonblank(240),
					version: z.string().max(200).nullable(),
					contentVersion: z
						.string()
						.regex(/^sha256:[0-9a-f]{64}$/)
						.optional(),
					fetchedAt: time.nullable(),
					complete: z.boolean(),
					stale: z.boolean(),
				}),
			)
			.max(500),
	})
	.refine(
		(value) => new TextEncoder().encode(JSON.stringify(value)).length <= GITHUB_DAILY_MAX_BYTES,
	);
export type GithubDaily = z.infer<typeof githubDailySchema>;
export type GithubDailyResource = Omit<
	AgentResource,
	"payload" | "type" | "repository" | "status"
> & {
	type: "github-daily";
	repository: null;
	status: "completed";
	payload: GithubDaily;
};
export type GithubDailyHistory = {
	account_id: string;
	items: GithubDailyResource[];
	invalidCount: number;
};

export function decodeGithubDaily(value: unknown): GithubDaily | null {
	try {
		if (new TextEncoder().encode(JSON.stringify(value)).length > GITHUB_DAILY_MAX_BYTES)
			return null;
		return githubDailySchema.safeParse(value).success ? (value as GithubDaily) : null;
	} catch {
		return null;
	}
}
const envelope = z.object({
	id: resourceId,
	account_id: z.string().min(1),
	type: z.literal("github-daily"),
	repository: z.null(),
	status: z.literal("completed"),
	source_version: z.string().max(200).nullable(),
	revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	created_at: z.string().datetime({ offset: true }),
	updated_at: z.string().datetime({ offset: true }),
	payload: z.unknown(),
});
export function decodeGithubDailyResource(value: unknown): GithubDailyResource | null {
	try {
		const parsed = envelope.safeParse(value);
		if (!parsed.success) return null;
		const row = parsed.data;
		const payload = decodeGithubDaily(
			typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
		);
		return payload && row.id === `github-daily-${payload.date}` ? { ...row, payload } : null;
	} catch {
		return null;
	}
}
