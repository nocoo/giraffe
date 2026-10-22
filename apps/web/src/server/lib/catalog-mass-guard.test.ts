import { expect, it } from "vitest";
import { fixture, later, missing, now, proof } from "../../../../../tests/fixtures/catalog-safety";
import { readCatalogChanges } from "./catalog-read";

it.each([
	{ owned: 5, replaceBoth: true, omit: "", guarded: true },
	{ owned: 39, replaceBoth: true, omit: "", guarded: true },
	{ owned: 40, replaceBoth: true, omit: "", guarded: false },
	{ owned: 5, replaceBoth: false, omit: "", guarded: false },
	{ owned: 5, replaceBoth: false, omit: "nocoo/kept-0", guarded: true },
	{ owned: 5, replaceBoth: true, omit: proof.name_with_owner, guarded: true },
])(
	"R7 mass guard spans replacement generations: owned=$owned both=$replaceBoth omit=$omit guarded=$guarded",
	async ({ owned, replaceBoth, omit, guarded }) => {
		const context = await fixture();
		const second = { ...missing, name_with_owner: "nocoo/second" };
		const rows = [
			proof,
			missing,
			second,
			...Array.from({ length: owned - 3 }, (_, index) => ({
				...missing,
				name_with_owner: `nocoo/kept-${index}`,
			})),
		];
		const ids: Record<string, string> = Object.fromEntries(
			rows.map((row, index) => [row.name_with_owner, `R_KEEP_${index}`]),
		);
		ids[proof.name_with_owner] = "R_PROOF";
		ids[missing.name_with_owner] = "R_OLD";
		ids[second.name_with_owner] = "R_SECOND";
		const unknown = () => Response.json({ data: { node: null } });
		await context.publish((await context.plan(unknown, rows, ids, now)).result);
		async function saveMutable(repo: string, generation: number) {
			const identity = ids[repo];
			const payload = JSON.stringify({
				repo,
				status: "success",
				observation: { source: "run", repo, version: identity },
			});
			await context.raw
				.prepare("INSERT OR REPLACE INTO repo_stars VALUES('a',?,?,?,?,?)")
				.bind(repo, generation % 2, generation % 2 ? "agent" : "owner", now, identity)
				.run();
			await context.raw
				.prepare("INSERT OR REPLACE INTO repo_statistics VALUES('a',?,?)")
				.bind(repo, generation % 2)
				.run();
			await context.raw
				.prepare("INSERT OR REPLACE INTO factory_repo_state VALUES('a',?,?,?)")
				.bind(repo, identity, payload)
				.run();
		}
		for (const row of rows) await saveMutable(row.name_with_owner, 0);
		const displaced: string[] = [];
		for (const generation of [1, 2]) {
			displaced.push(ids[missing.name_with_owner] as string);
			ids[missing.name_with_owner] = `R_OLD_${generation}`;
			if (generation === 1 || replaceBoth) {
				displaced.push(ids[second.name_with_owner] as string);
				ids[second.name_with_owner] = `R_SECOND_${generation}`;
			}
			const at = new Date(Date.UTC(2026, 9, 22, generation)).toISOString();
			await context.publish((await context.plan(unknown, rows, ids, at)).result);
			await saveMutable(missing.name_with_owner, generation);
			await saveMutable(second.name_with_owner, generation);
		}
		const quarantine = () =>
			context.raw
				.prepare("SELECT * FROM catalog_displaced_state ORDER BY identity_key,table_name")
				.all();
		const catalog = () =>
			context.raw.prepare("SELECT * FROM catalog_repositories ORDER BY identity_key").all();
		const beforeQuarantine = await quarantine();
		const beforeCatalog = await catalog();
		const beforeMutable = await context.saved();
		expect(beforeQuarantine.results).toHaveLength(displaced.length * 3);
		const { result, requests } = await context.plan(
			() =>
				Response.json({
					data: { node: null },
					errors: [{ type: "NOT_FOUND", message: "Not Found", path: ["node"] }],
				}),
			rows.filter((row) => row.name_with_owner !== omit),
			ids,
			later,
		);
		const candidates = [...displaced, ...(omit ? [ids[omit]] : [])].sort();
		expect(result.warning).toBe(guarded ? "catalog_mass_removal_guard" : null);
		expect(result.removedIdentities.sort()).toEqual(guarded ? [] : candidates);
		expect(result.removed).toEqual([]);
		expect(requests.map((request) => request.variables.id).sort()).toEqual(
			guarded ? [] : candidates,
		);
		expect(result.unconfirmed.map((event) => event.github_id).sort()).toEqual(
			guarded ? candidates : [],
		);
		expect(result.unconfirmed.every((event) => event.reason === "mass_removal_guard")).toBe(true);
		await context.publish(result);
		expect(await context.saved()).toEqual(beforeMutable);
		expect((await quarantine()).results).toEqual(guarded ? beforeQuarantine.results : []);
		const affectedBefore = beforeCatalog.results.filter((row) =>
			candidates.includes(row.github_id as string),
		);
		const affectedAfter = (await catalog()).results.filter((row) =>
			candidates.includes(row.github_id as string),
		);
		expect(affectedAfter).toEqual(
			guarded ? affectedBefore : affectedBefore.map((row) => ({ ...row, removed_at: later })),
		);
		const changes = await readCatalogChanges(context.db, "a", { since: [later] });
		expect(changes.removed.map((event) => event.github_id).sort()).toEqual(
			guarded ? [] : candidates,
		);
		expect(changes.unconfirmed.map((event) => event.github_id).sort()).toEqual(
			guarded ? candidates : [],
		);
		expect(changes.unconfirmed.every((event) => event.reason === "mass_removal_guard")).toBe(true);
		expect(changes.warning_code).toBe(guarded ? "catalog_mass_removal_guard" : null);
	},
);
