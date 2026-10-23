import type { FactoryCoverage, FactoryWindow } from "../../lib/factory-types";
import { prSnapshot } from "../../lib/pull-request";

export type ContentMetadata = { hash: string; version?: string; fullVersion?: string };
const CONTENT_META = new WeakMap<object, ContentMetadata>();

export function storedContent(
	data: Record<string, unknown> | null | undefined,
): ContentMetadata | null {
	return data ? (CONTENT_META.get(data) ?? null) : null;
}

export function withContent(data: Record<string, unknown>, meta: ContentMetadata | null) {
	if (meta) CONTENT_META.set(data, meta);
	else CONTENT_META.delete(data);
	return data;
}

export function decodeContent(encoded: string | null | undefined): ContentMetadata | null {
	if (!encoded) return null;
	const meta = JSON.parse(encoded) as ContentMetadata;
	return meta;
}

export async function savedContentMeta(
	resource: string,
	data: Record<string, unknown>,
	window?: FactoryWindow,
) {
	const kind =
		resource.startsWith("factory:v:") || resource.startsWith("factory:catalog:")
			? "factory"
			: resource;
	const normalized = prSnapshot(data);
	return JSON.stringify({
		hash: await contentVersion(kind, window ? { ...normalized, ranges: [window] } : normalized),
		fullVersion: await observationVersion(normalized),
		...(typeof data.runId === "string" ? { version: data.runId } : {}),
	});
}

export async function composeContent(
	inputs: Record<string, string | null>,
	selection: Record<string, unknown> = {},
) {
	if (Object.values(inputs).some((value) => value === null)) return null;
	return contentVersion("composite", { inputs, selection });
}

export async function snapshotContentInput(snapshot: Record<string, unknown> | null | undefined) {
	if (!snapshot) return "missing";
	const metadata = storedContent(snapshot);
	return (
		metadata?.hash ??
		`unhashed:${metadata?.fullVersion ?? (await observationVersion(prSnapshot(snapshot)))}`
	);
}

export function factoryStreamContent(saved: string | null, published: FactoryCoverage) {
	return published.retained
		? composeContent({ evidence: saved }, { coverage: coverage(published) })
		: saved;
}

function omit(value: unknown, keys: string[]): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries((value ?? {}) as Record<string, unknown>).filter(([key]) => !keys.includes(key)),
	);
}

function coverage(value: unknown) {
	const data = omit(value, ["fetchedAt", "sourceFetchedAt", "pages", "strategy", "source"]);
	if (data.observation)
		data.observation = omit(data.observation, [
			"version",
			"refreshedAt",
			"publishedAt",
			"metadataAt",
			"source",
			"repo",
			"head",
		]);
	return data;
}

function contribution(value: unknown) {
	if (!value) return value;
	const data = omit(value, ["fetchedAt", "observedAt"]);
	if (Array.isArray(data.days)) data.days = data.days.map((day) => omit(day, ["observedAt"]));
	return data;
}

export function contentData(resource: string, value: Record<string, unknown>) {
	const data = omit(value, [
		"fetched_at",
		"repository_fetched_at",
		"source_fetched_at",
		"publication",
	]);
	if (data.freshness && typeof data.freshness === "object")
		data.freshness = omit(data.freshness, ["oldestAt", "latestAt"]);
	if (resource === "factory" || resource.startsWith("factory:")) {
		for (const key of [
			"runId",
			"revision",
			"leaseUntil",
			"startedAt",
			"requests",
			"rate",
			"rateLimits",
			"cursor",
			"publication",
			"next",
		])
			delete data[key];
		if (data.coverage) data.coverage = coverage(data.coverage);
		if (data.observation)
			data.observation = omit(data.observation, [
				"version",
				"refreshedAt",
				"publishedAt",
				"metadataAt",
				"source",
				"repo",
			]);
		if (data.inventory) data.inventory = omit(data.inventory, ["pages", "after"]);
		if (Array.isArray(data.repos))
			data.repos = data.repos.map((value) => {
				const repo = omit(value, ["metadataAt"]);
				if (repo.observation)
					repo.observation = omit(repo.observation, [
						"version",
						"refreshedAt",
						"publishedAt",
						"metadataAt",
						"source",
						"repo",
					]);
				repo.coverage = Object.fromEntries(
					Object.entries(repo.coverage as Record<string, unknown>).map(([stream, value]) => [
						stream,
						coverage(value),
					]),
				);
				return repo;
			});
		if (data.contribution) data.contribution = contribution(data.contribution);
		if (data.contributionObservation)
			data.contributionObservation = omit(data.contributionObservation, ["version", "fetchedAt"]);
	}
	if (resource === "contributions") {
		delete data.observedAt;
		if (Array.isArray(data.days)) data.days = data.days.map((day) => omit(day, ["observedAt"]));
	}
	return data;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

async function digest(text: string) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function observationVersion(data: unknown) {
	return digest(JSON.stringify(data));
}

export function contentVersion(resource: string, data: Record<string, unknown>) {
	return digest(canonical(contentData(resource, data)));
}
