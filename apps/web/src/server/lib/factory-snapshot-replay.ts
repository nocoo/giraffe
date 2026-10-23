import { MAX_STAGED_BYTES, utf8Bytes } from "./collect";
import type { Db } from "./db/d1";
import { fenced, type RunLease } from "./db/factory-runs";
import { ApiError } from "./errors";
import { boundedJson } from "./factory-publish";
import { type GithubClient, MAX_FETCHES, TruncatedError } from "./github-client";
import {
	GithubUnavailableError,
	githubUnavailability,
	unavailableReason,
} from "./github-unavailable";

type Entry = {
	key: string;
	graphqlErrors: GithubClient["graphqlErrors"];
} & (
	| { kind: "rest"; body: string; status: number; link: string | null }
	| { kind: "graphql"; data: Record<string, unknown> }
	| {
			kind: "unavailable";
			status: number;
			code: string;
			reasonCode?: GithubUnavailableError["reasonCode"];
			unambiguousNotFound?: boolean;
	  }
);

export class SnapshotPageReady extends ApiError {
	constructor() {
		super(409, "factory_yield", "snapshot page ready");
	}
}

export async function snapshotReplay(
	db: Db,
	lease: RunLease,
	resource: string,
	cursor: number,
	upstream: GithubClient,
	now: string,
	heartbeat?: () => Promise<void>,
) {
	const prefix = `snapshot-replay:${resource}:${cursor}:`;
	const rows = await db
		.prepare(
			"SELECT stream FROM factory_resources WHERE run_id=? AND repo='' AND substr(stream,1,?)=? ORDER BY stream",
		)
		.bind(lease.run.id, prefix.length, prefix)
		.all<{ stream: string }>();
	const saved = new Set(
		rows.results.map((row) => Number(row.stream.slice(prefix.length).split(":")[0])),
	);
	let position = 0;
	let requested = false;
	let pending: { text: string; index: number } | undefined;
	const client: GithubClient = {
		get count() {
			return Math.max(position, upstream.count);
		},
		graphqlErrors: [],
		async githubFetch() {
			throw new ApiError(500, "internal_error", "snapshot requires the GitHub API boundary");
		},
		async githubApi(token, path, init) {
			if (init) throw new ApiError(500, "internal_error", "snapshot requests must be read-only");
			const entry = await request(token, ["rest", path], async (key) => {
				const response = await upstream.githubApi(token, path);
				return {
					key,
					kind: "rest",
					body: await response.text(),
					status: response.status,
					link: response.headers.get("link"),
					graphqlErrors: upstream.graphqlErrors,
				};
			});
			if (entry.kind !== "rest")
				throw new ApiError(422, "snapshot_incomplete", "snapshot request changed");
			return new Response(entry.status === 204 || entry.status === 205 ? null : entry.body, {
				status: entry.status,
				headers: entry.link ? { link: entry.link } : {},
			});
		},
		async githubGraphql(token, query, variables) {
			const entry = await request(token, ["graphql", query, variables], async (key) => {
				const data = await upstream.githubGraphql(token, query, variables);
				return { key, kind: "graphql", data, graphqlErrors: upstream.graphqlErrors };
			});
			if (entry.kind !== "graphql")
				throw new ApiError(422, "snapshot_incomplete", "snapshot request changed");
			return structuredClone(entry.data);
		},
	};
	async function request(
		token: string,
		identity: unknown[],
		fetchEntry: (key: string) => Promise<Entry>,
	): Promise<Entry> {
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(identity)),
		);
		const key = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		let entry: Entry | undefined;
		if (saved.has(position)) {
			const pagePrefix = `${prefix}${String(position).padStart(2, "0")}:`;
			const chunks = await db
				.prepare(
					"SELECT payload FROM factory_resources WHERE run_id=? AND repo='' AND substr(stream,1,?)=? ORDER BY stream",
				)
				.bind(lease.run.id, pagePrefix.length, pagePrefix)
				.all<{ payload: string }>();
			entry = JSON.parse(
				chunks.results.map((chunk) => JSON.parse(chunk.payload) as string).join(""),
			) as Entry;
		}
		if (entry && entry.key !== key)
			throw new ApiError(422, "snapshot_incomplete", "snapshot request changed");
		if (!entry) {
			if (position >= MAX_FETCHES) throw new TruncatedError();
			if (requested) throw new SnapshotPageReady();
			requested = true;
			try {
				entry = await fetchEntry(key);
			} catch (error) {
				if (!(error instanceof ApiError) || !githubUnavailability(error)) throw error;
				entry = {
					key,
					kind: "unavailable",
					status: error.status,
					code: error.code,
					graphqlErrors: upstream.graphqlErrors,
					...(error instanceof GithubUnavailableError
						? { reasonCode: error.reasonCode, unambiguousNotFound: error.unambiguousNotFound }
						: {}),
				};
			}
			await heartbeat?.();
			const text = JSON.stringify(entry);
			if (token && text.includes(token))
				throw new ApiError(422, "snapshot_incomplete", "snapshot response contains credentials");
			pending = { text, index: position };
		}
		position++;
		client.graphqlErrors = structuredClone(entry.graphqlErrors);
		if (entry.kind === "unavailable") {
			if (entry.reasonCode)
				throw new GithubUnavailableError(
					entry.status,
					entry.unambiguousNotFound ? "Not Found" : unavailableReason(entry.reasonCode).reason,
					entry.reasonCode === "permission_denied",
				);
			throw new ApiError(entry.status, entry.code, "GitHub resource unavailable");
		}
		return entry;
	}
	return {
		client,
		get writes() {
			if (!pending) return [];
			const { text, index } = pending;
			if (utf8Bytes(text) > MAX_STAGED_BYTES)
				throw new ApiError(
					422,
					"snapshot_incomplete",
					"snapshot replay page exceeds bounded storage",
				);
			const writes: D1PreparedStatement[] = [];
			for (let offset = 0; offset < text.length; offset += 250_000) {
				writes.push(
					fenced(
						db,
						lease,
						now,
						"INSERT INTO factory_resources(run_id,repo,stream,payload) SELECT ?,'',?,? WHERE $guard ON CONFLICT(run_id,repo,stream) DO UPDATE SET payload=excluded.payload",
						[
							lease.run.id,
							`${prefix}${String(index).padStart(2, "0")}:${String(offset / 250_000).padStart(3, "0")}`,
							boundedJson(text.slice(offset, offset + 250_000)),
						],
					),
				);
			}
			return writes;
		},
		cleanup: () =>
			rows.results.length
				? [
						fenced(
							db,
							lease,
							now,
							"DELETE FROM factory_resources WHERE run_id=? AND repo='' AND substr(stream,1,?)=? AND $guard",
							[lease.run.id, prefix.length, prefix],
						),
					]
				: [],
	};
}
