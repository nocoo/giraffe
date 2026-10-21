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

it.each(["dependabot", "code_scanning"])(
	"keeps the available feature visible when %s is unavailable",
	async (denied) => {
		const gh = github((url) =>
			url.endsWith("/graphql")
				? denied === "dependabot"
					? Response.json({ message: "Dependabot alerts are disabled" }, { status: 403 })
					: Response.json({
							data: {
								repository: {
									vulnerabilityAlerts: {
										nodes: Array.from({ length: 6 }, (_, id) => ({ id: String(id) })),
										pageInfo: { hasNextPage: false },
									},
								},
							},
						})
				: denied === "code_scanning"
					? Response.json({ message: "Not Found" }, { status: 404 })
					: Response.json([{ html_url: "https://example.test/scan" }]),
		);
		const data = await collectKind(gh, "fake", "repo:o/n:security", []);
		expect(data).toMatchObject({
			unavailable: false,
			truncated: false,
			dependabot_open: denied === "dependabot" ? null : 6,
			code_scanning_open: denied === "code_scanning" ? null : 1,
			features: {
				dependabot: {
					status: denied === "dependabot" ? "unavailable" : "available",
					reason_code: denied === "dependabot" ? "alerts_disabled" : null,
				},
				code_scanning: {
					status: denied === "code_scanning" ? "unavailable" : "available",
					reason_code: denied === "code_scanning" ? "not_found" : null,
				},
			},
		});
		expect(data.reason_code).toBeUndefined();
		expect(data.items).toHaveLength(denied === "dependabot" ? 1 : 6);
	},
);

it("reports unavailable feature counts as null, but a complete empty feature as zero", async () => {
	for (const available of [false, true]) {
		const gh = github((url) =>
			available
				? url.endsWith("/graphql")
					? Response.json({
							data: {
								repository: {
									vulnerabilityAlerts: { nodes: [], pageInfo: { hasNextPage: false } },
								},
							},
						})
					: Response.json([])
				: Response.json({ message: "Not Found" }, { status: 404 }),
		);
		expect(await collectKind(gh, "fake", "repo:o/n:security", [])).toMatchObject({
			unavailable: !available,
			dependabot_open: available ? 0 : null,
			code_scanning_open: available ? 0 : null,
			features: {
				dependabot: { status: available ? "available" : "unavailable" },
				code_scanning: { status: available ? "available" : "unavailable" },
			},
		});
	}
});

it("isolates reasons across features and never calls partially covered empty repositories zero", async () => {
	const gh = github((url, init) => {
		if (url.endsWith("/graphql")) {
			const { variables } = JSON.parse(String(init?.body));
			return variables.n === "a"
				? Response.json({
						data: {
							repository: {
								vulnerabilityAlerts: {
									nodes: [],
									pageInfo: { hasNextPage: false },
								},
							},
						},
					})
				: Response.json({ message: "Dependabot alerts are disabled" }, { status: 403 });
		}
		return url.includes("/o/a/")
			? Response.json({ message: "Not Found" }, { status: 404 })
			: Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
	});
	expect(await collectKind(gh, "fake", "alerts", ["o/a", "o/b"])).toMatchObject({
		truncated: false,
		unavailable: false,
		dependabot_open: null,
		code_scanning_open: null,
		features: {
			dependabot: { status: "partial", reason_code: "alerts_disabled" },
			code_scanning: { status: "unavailable", reason_code: "not_found" },
		},
	});
});
