import { type FieldNode, Kind, type OperationDefinitionNode, parse } from "graphql";
import { expect, it } from "vitest";
import type { RefreshDay } from "../../../lib/refresh-types";
import {
	accountCatalogQuery,
	accountQuery,
	contributionCalendarQuery,
	itemQuery,
	repositoryQuery,
} from "./queries";

const sampleDay: RefreshDay = {
	date: "2026-10-28",
	since: "2026-10-27T16:00:00.000Z",
	until: "2026-10-28T16:00:00.000Z",
};

function topLevelFields(document: string): string[] {
	const ast = parse(document);
	const operation = ast.definitions.find(
		(definition): definition is OperationDefinitionNode =>
			definition.kind === Kind.OPERATION_DEFINITION,
	);
	if (!operation) throw new Error("missing GraphQL operation");
	return operation.selectionSet.selections
		.filter((selection): selection is FieldNode => selection.kind === Kind.FIELD)
		.map((selection) => selection.name.value);
}

const documents: Array<{ name: string; query: string; rateLimitTopLevel?: boolean }> = [
	{ name: "accountCatalogQuery", query: accountCatalogQuery, rateLimitTopLevel: true },
	{ name: "accountQuery", query: accountQuery, rateLimitTopLevel: true },
	{ name: "contributionCalendarQuery", query: contributionCalendarQuery, rateLimitTopLevel: true },
	{
		name: "repositoryQuery",
		query: repositoryQuery([sampleDay], ["commits", "issues", "releases"]),
		rateLimitTopLevel: true,
	},
	{
		name: "repositoryQuery with lifecycle",
		query: repositoryQuery([sampleDay], ["issues", "prs"], true),
		rateLimitTopLevel: true,
	},
	{ name: "itemQuery issues", query: itemQuery("issues") },
	{ name: "itemQuery prs", query: itemQuery("prs") },
];

it.each(documents)("parses exported GraphQL document: $name", ({ query, rateLimitTopLevel }) => {
	expect(() => parse(query)).not.toThrow();
	if (rateLimitTopLevel) expect(topLevelFields(query)).toContain("rateLimit");
});

it("notes that tests/fixtures/refresh-upstream.ts accepts arbitrary JSON and does not validate query syntax", () => {
	expect(contributionCalendarQuery.includes("rateLimit")).toBe(true);
});
