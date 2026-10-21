import { expect, it } from "vitest";
import { securityKpi } from "./security";

it("renders feature-specific status without turning unavailable or partial zero into zero", () => {
	const snapshot = {
		unavailable: false,
		truncated: false,
		dependabot_open: 0,
		code_scanning_open: null,
	};
	expect(securityKpi(snapshot, "dependabot")).toEqual({
		value: "0",
		subtitle: "旧快照：功能状态未知",
	});
	for (const status of ["available", "partial", "unavailable"] as const) {
		for (const reason_code of [null, "alerts_disabled", "code_scanning_disabled"] as const) {
			const features = {
				dependabot: { status, reason_code, reason: null },
				code_scanning: { status, reason_code, reason: null },
			};
			expect(securityKpi({ ...snapshot, features }, "dependabot")).toEqual({
				value: status === "available" ? "0" : "—",
				subtitle:
					status === "available"
						? "可用"
						: status === "partial"
							? "覆盖不完整"
							: reason_code
								? "未启用"
								: "不可用",
			});
		}
	}
});
