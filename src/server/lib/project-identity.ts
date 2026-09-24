import { z } from "zod";
import { type ProjectIdentity, projectKey } from "../../lib/project-identity";
import { type Env, envMode } from "../env";
import { ApiError } from "./errors";

const https = z.url({ protocol: /^https$/ });
const schema = z.object({
	schemaVersion: z.literal(1),
	owner: z.string(),
	repo: z.string(),
	title: z.string().min(1),
	description: z.object({ en: z.string() }),
	archived: z.boolean(),
	github: https,
	website: https.nullable(),
	url: https,
	icons: z.object({ small: https, large: https }),
	logos: z.array(
		z.object({
			url: https,
			width: z.number().positive(),
			height: z.number().positive(),
			format: z.string(),
			role: z.string(),
			background: z.string(),
			usage: z.string(),
			theme: z.string(),
		}),
	),
});

export function parseProjectIdentity(data: unknown, key: string): ProjectIdentity {
	const project = schema.parse(data);
	if (
		projectKey(`${project.owner}/${project.repo}`) !== key ||
		project.github.toLowerCase() !== `https://github.com/${key}`
	)
		throw new Error("project identity mismatch");
	const navigation = project.logos.filter(
		(logo) =>
			logo.role === "project-identity" &&
			logo.background === "transparent" &&
			logo.usage === "navigation" &&
			logo.theme === "any" &&
			logo.format === "png",
	);
	const select = (size: number) =>
		navigation
			.filter((logo) => Math.min(logo.width, logo.height) >= size)
			.sort((a, b) => a.width * a.height - b.width * b.height)[0]?.url ?? project.icons.small;
	return {
		owner: project.owner,
		repo: project.repo,
		title: project.title,
		description: project.description.en,
		archived: project.archived,
		github: project.github,
		website: project.website,
		url: project.url,
		icons: project.icons,
		navigationIcon: select(64),
		favicon: select(32),
	};
}

export function projectApiBase(env: Env): string {
	if (envMode(env.ENVIRONMENT) !== "production" && env.HEXLY_API_BASE) {
		const url = new URL(env.HEXLY_API_BASE);
		if (
			url.protocol !== "http:" ||
			url.hostname !== "127.0.0.1" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new ApiError(503, "internal_error", "invalid identity fixture endpoint");
		return env.HEXLY_API_BASE;
	}
	return "https://hexly.ai/api/projects";
}

export async function fetchProjectIdentity(
	repository: string,
	base = "https://hexly.ai/api/projects",
): Promise<ProjectIdentity | null> {
	const key = projectKey(repository);
	if (!key) throw new ApiError(400, "validation_failed", "invalid repository");
	let response: Response;
	try {
		response = await fetch(`${base}/${key}`, {
			signal: AbortSignal.timeout(3000),
			redirect: "manual",
		});
	} catch {
		throw new ApiError(503, "project_identity_network", "project identity unavailable");
	}
	if (response.status === 404) return null;
	if (!response.ok)
		throw new ApiError(
			503,
			`project_identity_http_${response.status}`,
			"project identity unavailable",
		);
	try {
		return parseProjectIdentity(await response.json(), key);
	} catch {
		throw new ApiError(503, "project_identity_invalid", "project identity unavailable");
	}
}
