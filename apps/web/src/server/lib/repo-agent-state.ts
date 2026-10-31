import {
	agentStateSummary,
	REPO_AGENT_STATE_MAX_BYTES,
	type RepoAgentState,
	type RepoAgentStateSummary,
	type RepoAgentStateWrite,
	repoAgentStateWriteSchema,
} from "../../lib/repo-agent-state";
import { catalogRowIdentityFromRecord, identifyCatalogRow } from "./catalog-identity";
import { invalidateDashboardWarmCacheSafely } from "./dashboard-response-cache";
import type { Db } from "./db/d1";
import { ApiError } from "./errors";

type StateRow = {
	identity_key: string;
	repo: string;
	payload: string | null;
	revision: number | null;
	updated_at: string | null;
	updated_by: string | null;
};
const TARGET =
	"SELECT repo_id FROM refresh_catalog WHERE account_id=? AND repo=? COLLATE NOCASE AND active=1";
const RETURNING =
	"RETURNING identity_key,payload,revision,updated_at,updated_by,(SELECT repo FROM refresh_catalog c WHERE c.account_id=repo_agent_state.account_id AND c.repo_id=repo_agent_state.identity_key AND c.active=1) AS repo";
const NEXT_REVISION =
	"(SELECT COALESCE(MAX(revision),0)+1 FROM repo_agent_state WHERE account_id=?)";

function wire(account: string, row: StateRow): RepoAgentState {
	return {
		account_id: account,
		repo: row.repo,
		repo_removed: false,
		payload: row.payload === null ? null : (JSON.parse(row.payload) as Record<string, unknown>),
		revision: row.revision,
		updated_at: row.updated_at,
		updated_by: row.updated_by,
	};
}
async function stateRow(db: Db, account: string, name: string) {
	const row = await db
		.prepare(
			`SELECT c.repo_id AS identity_key,c.repo,s.payload,s.revision,s.updated_at,s.updated_by FROM refresh_catalog c LEFT JOIN repo_agent_state s ON s.account_id=c.account_id AND s.identity_key=c.repo_id WHERE c.account_id=? AND c.active=1 AND c.repo_id=(${TARGET})`,
		)
		.bind(account, account, name)
		.first<StateRow>();
	if (!row) throw new ApiError(404, "not_found", "Repository not found");
	return row;
}
export async function readRepoAgentState(
	db: Db,
	account: string,
	name: string,
): Promise<RepoAgentState> {
	return wire(account, await stateRow(db, account, name));
}

function headerRevision(header: string | undefined) {
	if (header === undefined) return undefined;
	if (!/^"(?:0|[1-9]\d*)"$/.test(header))
		throw new ApiError(400, "invalid_payload", "Invalid If-Match revision");
	const revision = Number(header.slice(1, -1));
	if (!Number.isSafeInteger(revision))
		throw new ApiError(400, "invalid_payload", "Invalid If-Match revision");
	return revision;
}

export async function writeRepoAgentState(
	db: Db,
	account: string,
	name: string,
	input: unknown,
	actor: string,
	ifMatch?: string,
): Promise<RepoAgentState> {
	const parsed = repoAgentStateWriteSchema.safeParse(input);
	if (!parsed.success) throw new ApiError(400, "invalid_payload", "Invalid agent state payload");
	const original = input as RepoAgentStateWrite;
	const payload = JSON.stringify(original.payload);
	if (new TextEncoder().encode(payload).byteLength > REPO_AGENT_STATE_MAX_BYTES)
		throw new ApiError(400, "payload_too_large", "Agent state payload exceeds 16384 UTF-8 bytes");
	const revision = headerRevision(ifMatch) ?? original.revision;
	const previous = await stateRow(db, account, name);
	if (previous.revision !== null && revision === undefined)
		throw new ApiError(428, "precondition_required", "Current revision is required");
	if (revision !== undefined && revision !== (previous.revision ?? 0))
		throw new ApiError(409, "revision_conflict", "Agent state changed");
	const now = new Date().toISOString();
	const row =
		previous.revision === null
			? await db
					.prepare(
						`INSERT INTO repo_agent_state(account_id,identity_key,payload,revision,updated_at,updated_by) SELECT ?,repo_id,?,${NEXT_REVISION},?,? FROM refresh_catalog WHERE account_id=? AND repo_id=? AND repo_id=(${TARGET}) AND active=1 AND ${NEXT_REVISION}<=9007199254740991 ON CONFLICT(account_id,identity_key) DO NOTHING ${RETURNING}`,
					)
					.bind(
						account,
						payload,
						account,
						now,
						actor,
						account,
						previous.identity_key,
						account,
						name,
						account,
					)
					.first<StateRow>()
			: await db
					.prepare(
						`UPDATE repo_agent_state SET payload=?,revision=${NEXT_REVISION},updated_at=?,updated_by=? WHERE account_id=? AND identity_key=? AND revision=? AND ${NEXT_REVISION}<=9007199254740991 AND identity_key=(${TARGET}) ${RETURNING}`,
					)
					.bind(
						payload,
						account,
						now,
						actor,
						account,
						previous.identity_key,
						revision,
						account,
						account,
						name,
					)
					.first<StateRow>();
	if (!row) throw new ApiError(409, "revision_conflict", "Agent state changed");
	await invalidateDashboardWarmCacheSafely(db, account);
	return wire(account, row);
}

export async function enrichRepoAgentStates(
	db: Db,
	account: string,
	data: Record<string, unknown>,
) {
	const repos = (Array.isArray(data.repos) ? data.repos : []) as Record<string, unknown>[];
	if (!repos.length) return { ...data, repos: [] as Record<string, unknown>[] };
	const rows = await db
		.prepare(
			"SELECT s.identity_key,c.repo,s.revision,s.updated_at,CASE WHEN json_type(s.payload,'$.summary')='text' THEN json_extract(s.payload,'$.summary') END AS summary,CASE WHEN json_type(s.payload,'$.status')='text' THEN json_extract(s.payload,'$.status') END AS status FROM repo_agent_state s JOIN refresh_catalog c ON c.account_id=s.account_id AND c.repo_id=s.identity_key WHERE s.account_id=? AND c.active=1",
		)
		.bind(account)
		.all<{
			identity_key: string;
			repo: string;
			revision: number;
			updated_at: string;
			summary: unknown;
			status: unknown;
		}>();
	const states = new Map(rows.results.map((row) => [row.identity_key, row]));
	const identityByName = new Map(
		rows.results.map((row) => [row.repo.toLowerCase(), row.identity_key]),
	);
	return {
		...data,
		repos: repos.map((repo) => {
			const identity =
				catalogRowIdentityFromRecord(repo) ??
				(typeof repo.name_with_owner === "string"
					? identityByName.get(repo.name_with_owner.toLowerCase())
					: undefined);
			const state = identity === undefined ? undefined : states.get(identity);
			const summary: RepoAgentStateSummary | null = state
				? {
						revision: state.revision,
						updated_at: state.updated_at,
						...agentStateSummary({ summary: state.summary, status: state.status }),
					}
				: null;
			return identifyCatalogRow({ ...repo, agent_state: summary }, identity);
		}),
	};
}
