import { type SecurityFeatures, type SecuritySnapshot, securityCount } from "../../lib/security";
import { formatCount } from "../lib/format";

export function securityKpi(snapshot: SecuritySnapshot, feature: keyof SecurityFeatures) {
	const count = securityCount(snapshot, feature);
	const coverage = snapshot.features?.[feature];
	return {
		value: count === null ? "—" : formatCount(count),
		subtitle: !coverage
			? "旧快照：功能状态未知"
			: coverage.status === "available"
				? "可用"
				: coverage.status === "partial"
					? "覆盖不完整"
					: coverage.reason_code === "alerts_disabled" ||
							coverage.reason_code === "code_scanning_disabled"
						? "未启用"
						: "不可用",
	};
}
