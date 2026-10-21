import { expect, it } from "vitest";
import {
	retainSecurity,
	type SecurityFeatures,
	securityCount,
	securityIncomplete,
} from "./security";

const unavailable: SecurityFeatures = {
	dependabot: { status: "unavailable", reason_code: "not_found", reason: "Unavailable" },
	code_scanning: { status: "unavailable", reason_code: "not_found", reason: "Unavailable" },
};
const available: SecurityFeatures = {
	dependabot: { status: "available", reason_code: null, reason: null },
	code_scanning: { status: "available", reason_code: null, reason: null },
};

it("retains only proven good evidence with its original time and feature identity", () => {
	const old = {
		features: available,
		fetched_at: "old",
		dependabot_open: 7,
		code_scanning_open: 0,
		items: [{ source: "dependabot" }, { source: "code_scanning" }],
	};
	const retained = retainSecurity(old, unavailable);
	expect(retained).toEqual({
		dependabot: { open: 7, fetched_at: "old", items: [{ source: "dependabot" }] },
		code_scanning: { open: 0, fetched_at: "old", items: [{ source: "code_scanning" }] },
	});
	expect(
		retainSecurity({ ...old, features: unavailable, retained, fetched_at: "new" }, unavailable),
	).toEqual(retained);
	expect(retainSecurity(old, available)).toEqual({});
	expect(retainSecurity(null, unavailable)).toEqual({});
	expect(retainSecurity({ ...old, truncated: true }, unavailable)).toEqual({});
	expect(retainSecurity({ unavailable: true }, unavailable)).toEqual({});
	expect(retainSecurity({ features: available, fetched_at: "old" }, unavailable)).toEqual({});
	expect(retainSecurity({ dependabot_open: 0, fetched_at: "old" }, unavailable)).toEqual({
		dependabot: { open: 0, fetched_at: "old", items: [] },
	});
});

it("never presents unavailable or unconfirmed zero as complete zero", () => {
	const snapshot = {
		unavailable: false,
		truncated: false,
		dependabot_open: 0,
		code_scanning_open: 1,
	};
	expect(securityCount({ ...snapshot, features: unavailable }, "code_scanning")).toBeNull();
	expect(securityCount({ ...snapshot, features: available }, "dependabot")).toBe(0);
	expect(securityCount({ ...snapshot, unavailable: true }, "dependabot")).toBeNull();
	expect(securityCount({ ...snapshot, truncated: true }, "dependabot")).toBeNull();
	expect(securityCount({ ...snapshot, unavailable: true }, "code_scanning")).toBe(1);
	expect(securityIncomplete(null)).toBe(true);
	expect(securityIncomplete({ unavailable: true })).toBe(true);
	expect(securityIncomplete({ truncated: true })).toBe(true);
	expect(securityIncomplete(snapshot)).toBe(false);
	expect(securityIncomplete({ ...snapshot, features: available })).toBe(false);
	expect(securityIncomplete({ ...snapshot, features: unavailable })).toBe(true);
});
