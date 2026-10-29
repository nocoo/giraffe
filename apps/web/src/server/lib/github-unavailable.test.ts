import { expect, it } from "vitest";
import { github } from "../../../../../tests/fixtures/factory";
import { githubUnavailableFixtures } from "../../../../../tests/fixtures/github-unavailable";
import { ApiError } from "./errors";
import { GithubUnavailableError, githubUnavailability } from "./github-unavailable";

it.each([
	"Resource not accessible by personal access token",
	"Repository permission was revoked",
	"SAML enforcement requires authorization",
	"SSO authorization required",
	"Single sign-on access is restricted",
	"Insufficient OAuth scope",
	"Access denied for this repository",
])("fix1 permission-hidden 404 never proves deletion: %s", async (message) => {
	const gh = github(() => Response.json({ message }, { status: 404 }));
	await expect(gh.githubApi("fake", "/repositories/123")).rejects.toMatchObject({
		reasonCode: "permission_denied",
		unambiguousNotFound: false,
	});
});

it("fix1 only recognized not-found bodies provide safe deletion evidence", async () => {
	for (const body of ["not json", "null", "{}", '{"message":42}', '{"message":"unknown"}']) {
		const gh = github(() => new Response(body, { status: 404 }));
		await expect(gh.githubApi("fake", "/repositories/123")).rejects.toMatchObject({
			unambiguousNotFound: false,
		});
	}
	const gh = github(() => Response.json({ message: "Not Found" }, { status: 404 }));
	await expect(gh.githubApi("fake", "/repositories/123")).rejects.toMatchObject({
		unambiguousNotFound: true,
	});
	expect(new GithubUnavailableError(403, "Not Found").unambiguousNotFound).toBe(false);
});

it.each([
	{ headers: { "x-github-sso": "required; url=https://github.com/orgs/example/sso" } },
	{ details: { errors: [{ message: "Repository permission denied" }] } },
	{ details: { errors: [{ message: "Code scanning disabled; permission denied" }] } },
])("fix1 access restrictions outside the primary message remain unconfirmed: %j", async (extra) => {
	const gh = github(() =>
		Response.json(
			{ message: "Not Found", ...extra.details },
			{ status: 404, ...(extra.headers ? { headers: extra.headers } : {}) },
		),
	);
	await expect(gh.githubApi("fake", "/repositories/123")).rejects.toMatchObject({
		reasonCode: "permission_denied",
		unambiguousNotFound: false,
	});
});

it("fix1 GraphQL auxiliary access diagnostics cannot prove identity removal", async () => {
	for (const headers of [{}, { "x-github-sso": "required" }]) {
		const gh = github(() =>
			Response.json(
				{
					data: { node: null },
					errors: [{ type: "NOT_FOUND", message: "Not Found", extensions: { reason: "SAML" } }],
				},
				{ headers },
			),
		);
		await gh.githubGraphql("fake", "query Node", {});
		expect(gh.graphqlErrors[0]?.unambiguousNotFound).toBeUndefined();
		expect(gh.graphqlErrors[0]?.reasonCode).toBe("permission_denied");
	}
});

it.each([
	'{"message":"Not Found","errors":[{"message":"Repository \\u0070ermission denied"}]}',
	'{"message":"Not Found","errors":[{"message":"Token has insufficient scopes"}]}',
	'{"message":"Not Found","errors":[{"code":"insufficient_scopes"}]}',
])("fix1 decoded and plural access diagnostics veto REST deletion evidence: %s", async (body) => {
	const gh = github(() => new Response(body, { status: 404 }));
	await expect(gh.githubApi("fake", "/repositories/123")).rejects.toMatchObject({
		unambiguousNotFound: false,
		reasonCode: "permission_denied",
	});
});

it.each([
	{ extensions: { reason: "SAML permission denied" }, headers: {} },
	{ extensions: {}, headers: { "x-github-sso": "required" } },
])(
	"fix1 top-level GraphQL diagnostics and independent headers veto not-found: %j",
	async ({ extensions, headers }) => {
		const gh = github(() =>
			Response.json(
				{ data: { node: null }, errors: [{ type: "NOT_FOUND", message: "Not Found" }], extensions },
				{ headers },
			),
		);
		await gh.githubGraphql("fake", "query Node", {});
		expect(gh.graphqlErrors[0]?.unambiguousNotFound).toBeUndefined();
		expect(gh.graphqlErrors[0]?.reasonCode).toBe("permission_denied");
	},
);

it.each([
	{ message: "Could not resolve to a node with the global id of 'R_OLD'", safe: true },
	{ message: "Resource not accessible by personal access token", safe: false },
	{ message: "SAML permission denied", safe: false },
	{ message: "An unspecified lookup failure", safe: false },
])(
	"fix1 GraphQL node evidence distinguishes unavailable identity: $message",
	async ({ message, safe }) => {
		const gh = github(() =>
			Response.json({
				data: { node: null },
				errors: [{ type: "NOT_FOUND", message, path: ["node"] }],
			}),
		);
		await gh.githubGraphql("fake", "query Node($id:ID!){node(id:$id){id}}", { id: "R_OLD" });
		expect(gh.graphqlErrors[0]?.unambiguousNotFound === true).toBe(safe);
		expect(gh.graphqlErrors[0]?.nodeNotFound === true).toBe(safe);
		expect(JSON.stringify(gh.graphqlErrors)).not.toContain(message);
	},
);

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
	expect(gh.graphqlErrors).toEqual([
		{ type: "FORBIDDEN", reasonCode: "permission_denied", path: [] },
	]);
	expect(githubUnavailability(new Error("private"))).toBeNull();
	expect(githubUnavailability(new ApiError(502, "github_error", "private"))).toBeNull();
	expect(githubUnavailability(new ApiError(404, "not_found", "private"))).toMatchObject({
		reason_code: "not_found",
	});
});

it("fix1 explicit not-found identity must match the requested node", async () => {
	const gh = github(() =>
		Response.json({
			data: { node: null },
			errors: [
				{
					type: "NOT_FOUND",
					message: "Could not resolve to a node with the global id of 'R_OTHER'",
					path: ["node"],
				},
			],
		}),
	);
	await gh.githubGraphql("fake", "query Node($id:ID!){node(id:$id){id}}", { id: "R_OLD" });
	expect(gh.graphqlErrors[0]?.nodeNotFound).toBeUndefined();
});

it.each([{}, null, { node: { id: "R_PRESENT" } }, { node: [] }])(
	"fix1 node absence requires explicit raw null before normalization: %j",
	async (data) => {
		const gh = github(() =>
			Response.json({
				data,
				errors: [{ type: "NOT_FOUND", message: "Not Found", path: ["node"] }],
			}),
		);
		const query = "query Node($id:ID!){node(id:$id){id}}";
		if (data === null)
			await expect(gh.githubGraphql("fake", query, { id: "R_OLD" })).rejects.toThrow();
		else await gh.githubGraphql("fake", query, { id: "R_OLD" });
		expect(gh.graphqlErrors[0]?.nodeNotFound).toBeUndefined();
	},
);

it.each([undefined, null, 123])(
	"fix1 node absence requires a string requested identity: %j",
	async (id) => {
		const gh = github(() =>
			Response.json({
				data: { node: null },
				errors: [{ type: "NOT_FOUND", message: "Not Found", path: ["node"] }],
			}),
		);
		await gh.githubGraphql("fake", "query Node($id:ID!){node(id:$id){id}}", { id });
		expect(gh.graphqlErrors[0]?.nodeNotFound).toBeUndefined();
	},
);

it.each([undefined, [], ["viewer"], ["node", "owner"]])(
	"fix1 unrelated or unscoped GraphQL errors are not node deletion evidence: %j",
	async (path) => {
		const gh = github(() =>
			Response.json({
				data: { node: null },
				errors: [{ type: "NOT_FOUND", message: "Not Found", path }],
			}),
		);
		await gh.githubGraphql("fake", "query Node", {});
		expect(gh.graphqlErrors[0]?.unambiguousNotFound).toBeUndefined();
	},
);
