import { ApiError } from "../../apps/web/src/server/lib/errors";
import { stepFactory, streamKey } from "../../apps/web/src/server/lib/factory-collect";
import { github, memoryStore, NOW, ready } from "./factory";

export async function factoryCapacityOutcome(mode: "fresh" | "reused") {
	const state = ready("dependencies");
	const repo = state.repos[0];
	if (!repo) throw new Error("missing fixture repository");
	const key = streamKey(repo.name, "dependencies");
	const store = memoryStore();
	await store.write(key, {
		runId: "prior-good",
		items: [],
		next: null,
		ranges: [],
		coverage: { ...repo.coverage.dependencies, status: "complete", fetchedAt: NOW },
		manifests: [{ name: "own", version: "1", path: "package.json", url: repo.url }],
	});
	const previous = await store.read(key);
	if (!previous) throw new Error("missing prior evidence");
	const before = JSON.stringify(previous);
	const version = "v".repeat(1_300_000);
	const gh = github(() => {
		if (mode === "reused") throw new Error("unexpected upstream request during reuse");
		return Response.json({
			data: {
				repository: {
					package: {
						text: JSON.stringify({ name: "own", version, dependencies: { external: "1" } }),
					},
				},
			},
		});
	});
	let writes = 0;
	let code: string | null = null;
	const originalFetch = globalThis.fetch;
	const denyNetwork = () => {
		throw new Error("capacity fixture forbids network");
	};
	globalThis.fetch = Object.assign(denyNetwork, { preconnect: denyNetwork });
	try {
		await stepFactory(
			state,
			gh,
			"test-token",
			{
				read: store.read,
				write: async (resource, data) => {
					writes++;
					await store.write(resource, data);
				},
				...(mode === "reused"
					? {
							baseline: async () => ({
								data: {
									...previous,
									manifests: [{ name: "own", version, path: "package.json", url: repo.url }],
								},
								head: repo.head,
								window: state.window,
							}),
						}
					: {}),
			},
			NOW,
		);
	} catch (error) {
		if (!(error instanceof ApiError)) throw error;
		code = error.code;
	} finally {
		globalThis.fetch = originalFetch;
	}
	return {
		code,
		writes,
		unchanged: JSON.stringify(await store.read(key)) === before,
		requests: gh.count,
	};
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (mode !== "fresh" && mode !== "reused") throw new Error("invalid capacity fixture mode");
	console.log(JSON.stringify(await factoryCapacityOutcome(mode)));
}
