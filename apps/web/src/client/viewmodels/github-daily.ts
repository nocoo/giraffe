import { decodeGithubDailyResource, type GithubDailyHistory } from "../../lib/github-daily";
import { apiGet } from "../lib/api";
import { ensureSession, getActiveAccountId } from "./session";

export async function loadGithubDaily(): Promise<GithubDailyHistory> {
	const account = await ensureSession();
	const response = await apiGet<GithubDailyHistory>(`agent/accounts/${account}/analysis/daily`);
	if (response.account_id !== account || getActiveAccountId() !== account)
		throw new Error("Account changed");
	if (
		!Array.isArray(response.items) ||
		!Number.isSafeInteger(response.invalidCount) ||
		response.invalidCount < 0
	)
		throw new Error("Invalid daily report response");
	let invalidCount = response.invalidCount;
	const items = response.items.flatMap((row) => {
		const report = decodeGithubDailyResource(row);
		if (!report || report.account_id !== account) {
			invalidCount++;
			return [];
		}
		return [report];
	});
	return { account_id: account, items, invalidCount };
}
