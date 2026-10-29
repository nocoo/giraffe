import { describe, expect, it } from "vitest";
import type { CollectionContext } from "../refresh-collection-contract";
import { factoryRepo } from "./model";

const now = "2026-10-28T03:00:00.000Z";
const context = { now } as CollectionContext;
const raw = (open: Record<string, unknown>) => ({
	id: "R_1",
	nameWithOwner: "owner/project",
	...open,
});

describe("factory stock evidence", () => {
	it("records when each open count was actually observed", () => {
		const repo = factoryRepo(
			raw({ openIssues: { totalCount: 0 }, openPrs: { totalCount: 2 } }),
			context,
		);
		expect(repo.stockObservedAt).toEqual({ issues: now, prs: now });
		expect(repo).toMatchObject({ openIssues: 0, openPrs: 2 });
	});

	it("refuses to treat a defaulted zero count as observed stock", () => {
		const repo = factoryRepo(raw({ openIssues: {}, openPrs: { totalCount: null } }), context);
		expect(repo).toMatchObject({
			openIssues: 0,
			openPrs: 0,
			stockObservedAt: { issues: null, prs: null },
		});
	});

	it("keeps the streams independent when only one count is present", () => {
		expect(factoryRepo(raw({ openIssues: { totalCount: 3 } }), context).stockObservedAt).toEqual({
			issues: now,
			prs: null,
		});
		expect(factoryRepo(raw({ openPrs: { totalCount: 3 } }), context).stockObservedAt).toEqual({
			issues: null,
			prs: now,
		});
	});
});
