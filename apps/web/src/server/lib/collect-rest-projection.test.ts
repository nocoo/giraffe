import { expect, it, vi } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { collectKind } from "./collect";
import type { GithubClient } from "./github-client";

it("projects each REST page once instead of retaining and remapping previous raw rows", async () => {
	const projections = [0, 0];
	let requests = 0;
	const client: GithubClient = {
		...github(() => {
			throw new Error("no real network");
		}),
		get count() {
			return requests;
		},
		async githubApi() {
			const index = requests++;
			const response = new Response(null, {
				headers:
					index === 0
						? {
								link: '<https://api.github.com/repos/nocoo/app/releases?per_page=100&page=2>; rel="next"',
							}
						: {},
			});
			vi.spyOn(response, "json").mockResolvedValue([
				{
					id: index,
					get tag_name() {
						projections[index] = (projections[index] ?? 0) + 1;
						return `v${index}`;
					},
					ignored: "x".repeat(3_000_000),
				},
			]);
			return response;
		},
	};
	const result = await collectKind(client, "fake", "repo:nocoo/app:releases", [], 1_500_000);
	expect(result.truncated).toBe(false);
	expect(result.releases).toHaveLength(2);
	expect(projections).toEqual([1, 1]);
	expect(requests).toBe(2);
});
