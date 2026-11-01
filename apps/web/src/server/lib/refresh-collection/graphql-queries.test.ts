import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientSchema, type IntrospectionQuery, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { accountQuery, itemQuery, repositoryQuery } from "./queries";

const introspection = JSON.parse(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../../../node_modules/@octokit/graphql-schema/schema.json",
		),
		"utf8",
	),
) as IntrospectionQuery;
const schema = buildClientSchema(introspection);

const sampleDays = [
	{ date: "2026-10-29", since: "2026-10-28T16:00:00.000Z", until: "2026-10-29T16:00:00.000Z" },
	{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
];

function assertValidQuery(document: string) {
	const ast = parse(document);
	const errors = validate(schema, ast);
	expect(errors.map((error) => error.message)).toEqual([]);
}

describe("refresh GraphQL documents", () => {
	it("parses and validates RefreshAccount", () => {
		assertValidQuery(accountQuery);
	});
	it("parses and validates RefreshRepository without lifecycle search", () => {
		assertValidQuery(repositoryQuery(sampleDays, ["issues", "prs", "commits", "releases"], false));
	});
	it("parses and validates RefreshRepository with lifecycle search at Query root", () => {
		const query = repositoryQuery(sampleDays, ["issues", "prs"], true);
		expect(query).toContain("mergedLifecycle: search(");
		expect(query).toContain("closedLifecycle: search(");
		expect(query.indexOf("mergedLifecycle")).toBeGreaterThan(query.indexOf("rateLimit"));
		assertValidQuery(query);
	});
	it("parses and validates RefreshItems for issues and pull requests", () => {
		assertValidQuery(itemQuery("issues"));
		assertValidQuery(itemQuery("prs"));
	});
});
