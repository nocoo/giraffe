import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { githubUnavailableFixtures } from "../../../../../tests/fixtures/github-unavailable";
import { collectKind } from "./collect";

it.each(githubUnavailableFixtures)(
	"records known security unavailability without truncating ($code)",
	async ({ status, message, code }) => {
		const gh = github((url) =>
			url.endsWith("/graphql")
				? Response.json({
						data: { repository: null },
						errors: [
							{ type: status === 404 ? "NOT_FOUND" : "FORBIDDEN", message, path: ["repository"] },
						],
					})
				: Response.json({ message }, { status }),
		);
		const data = await collectKind(gh, "fake", "repo:o/n:security", []);
		expect(data).toMatchObject({ unavailable: true, truncated: false, reason_code: code });
		expect(data.reason).toEqual(expect.any(String));
		expect(JSON.stringify(data)).not.toContain("private upstream diagnostics");
	},
);

it("keeps malformed security data and pagination access loss incomplete, not benign unavailable", async () => {
	const malformed = github(() => Response.json({ data: { repository: {} } }));
	expect(await collectKind(malformed, "fake", "repo:o/n:security", [])).toMatchObject({
		truncated: true,
	});
	let pages = 0;
	const gh = github((url) => {
		if (!url.endsWith("/graphql")) return Response.json([]);
		pages++;
		return pages === 1
			? Response.json({
					data: {
						repository: {
							vulnerabilityAlerts: {
								nodes: [],
								pageInfo: { hasNextPage: true, endCursor: "next" },
							},
						},
					},
				})
			: Response.json({
					data: { repository: null },
					errors: [
						{
							type: "FORBIDDEN",
							message: "Resource not accessible by integration",
							path: ["repository"],
						},
					],
				});
	});
	expect(await collectKind(gh, "fake", "repo:o/n:security", [])).toMatchObject({ truncated: true });
});
