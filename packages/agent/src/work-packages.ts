import { prerelease, valid } from "semver";
import { z } from "zod";

export async function latestPackage(
	name: string,
	registry: string,
	transport: typeof fetch = fetch,
) {
	if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9][a-z0-9_.-]*$/i.test(name))
		throw new Error("Invalid npm package name.");
	const base = new URL(registry);
	if (
		base.protocol !== "https:" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		!["mirrors.tencent.com", "packagefeedproxy.microsoft.io"].includes(base.hostname)
	)
		throw new Error("An approved HTTPS package mirror is required.");
	const url = `${registry.replace(/\/$/, "")}/${encodeURIComponent(name)}/latest`;
	const response = await transport(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
	if (!response.ok) throw new Error(`Latest package metadata unavailable (${response.status}).`);
	const result = z
		.object({
			name: z.string(),
			version: z.string(),
			engines: z.record(z.string(), z.string()).optional(),
			peerDependencies: z.record(z.string(), z.string()).optional(),
			dependencies: z.record(z.string(), z.string()).optional(),
			deprecated: z.string().optional(),
		})
		.parse(await response.json());
	if (
		result.name !== name ||
		!valid(result.version) ||
		prerelease(result.version) ||
		result.deprecated
	)
		throw new Error(
			"Latest metadata must identify a non-deprecated stable release of the requested package.",
		);
	return { ...result, registry, verifiedAt: new Date().toISOString() };
}
