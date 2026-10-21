import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { githubUnavailableFixtures } from "../../../../../tests/fixtures/github-unavailable";
import { ApiError } from "./errors";
import { githubUnavailability } from "./github-unavailable";

it.each(githubUnavailableFixtures)(
	"classifies $status $code without retaining raw upstream messages",
	async ({ status, message, code }) => {
		const secret = `ghp_${"S".repeat(36)}`;
		const gh = github(() => Response.json({ message, private_diagnostics: secret }, { status }));
		try {
			await gh.githubApi("fake", "/repos/o/n/dependabot/alerts");
			throw new Error("Expected GitHub unavailable error");
		} catch (error) {
			expect(error).toMatchObject({ reasonCode: code });
			expect(JSON.stringify(error)).not.toContain(secret);
			expect(JSON.stringify(error)).not.toContain(message);
		}
	},
);

it("uses safe fallback codes for malformed error bodies and drops GraphQL diagnostics", async () => {
	for (const body of ["not json", "null", "{}", '{"message":42}']) {
		const gh = github(() => new Response(body, { status: 404 }));
		await expect(gh.githubApi("fake", "/repos/o/n/dependabot/alerts")).rejects.toMatchObject({
			reasonCode: "not_found",
		});
	}
	const gh = github(() =>
		Response.json({
			data: { repository: null },
			errors: [
				{
					type: "FORBIDDEN",
					message: "Resource not accessible by integration",
					private_diagnostics: "sensitive",
				},
			],
		}),
	);
	await gh.githubGraphql("fake", "query", {});
	expect(gh.graphqlErrors).toEqual([{ type: "FORBIDDEN", reasonCode: "permission_denied" }]);
	expect(githubUnavailability(new Error("private"))).toBeNull();
	expect(githubUnavailability(new ApiError(502, "github_error", "private"))).toBeNull();
	expect(githubUnavailability(new ApiError(404, "not_found", "private"))).toMatchObject({
		reason_code: "not_found",
	});
});
