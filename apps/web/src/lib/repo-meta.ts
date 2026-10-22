import { z } from "zod";

export type RepoCategory = "app" | "docs-vault" | "profile" | "repro" | "derivative";
export type RepoMetaFields = {
	created_at: string | null;
	first_seen_at: string | null;
	archived_at: string | null;
	deleted_at: string | null;
	category: RepoCategory | null;
	exclusion_reason: string | null;
	updated_at: string | null;
	field_sources: Partial<
		Record<"created_at" | "archived_at" | "category" | "exclusion_reason", "agent" | "catalog">
	>;
};
export type RepoMeta = RepoMetaFields & {
	account_id: string;
	repo: string;
	repo_removed: boolean;
};
export const repoMetaTimestampSchema = z.string().datetime({ offset: true });
export const repoMetaWriteSchema = z
	.strictObject({
		created_at: repoMetaTimestampSchema.optional(),
		archived_at: repoMetaTimestampSchema.optional(),
		category: z.enum(["app", "docs-vault", "profile", "repro", "derivative"]).optional(),
		exclusion_reason: z.string().max(200).optional(),
	})
	.refine((value) => Object.values(value).some((field) => field !== undefined));
export type RepoMetaWrite = z.output<typeof repoMetaWriteSchema>;
