import type { RepoMeta } from "../../lib/repo-meta";
import { ApiError } from "../lib/errors";
import { isValidRepoPart } from "./repo-detail";
import { loadKind } from "./snapshot";

const labels = new Map([
	["app", "应用"],
	["docs-vault", "文档库"],
	["profile", "个人主页"],
	["repro", "问题复现"],
	["derivative", "衍生项目"],
]);
export function categoryLabel(category: string | null | undefined): string {
	return labels.get(category ?? "") ?? "未分类";
}

export async function loadRepoMeta(
	owner: string,
	name: string,
): Promise<RepoMeta | { missing: true }> {
	if (!isValidRepoPart(owner) || !isValidRepoPart(name)) return { missing: true };
	try {
		return await loadKind<RepoMeta>(`repos/${owner}/${name}/meta`);
	} catch (error) {
		if (error instanceof ApiError && error.code === "not_found") return { missing: true };
		throw error;
	}
}
