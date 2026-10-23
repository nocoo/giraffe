import { describe, expect, it } from "vitest";
import {
	dependencyWorkflow,
	multilineReleaseWorkflow,
} from "../../../../../tests/fixtures/dependency-workflow";
import { rawEvent, rawRepo } from "../../../../../tests/fixtures/factory";
import {
	coverage,
	exclusion,
	mapDependencies,
	mapFactoryEvents,
	mapFactoryRepo,
	object,
	rows,
} from "./factory-map";

describe("GitHub factory normalization", () => {
	it.each(["issues", "prs", "actions", "releases"] as const)(
		"keeps an astral title at the %s code-point limit without adding an ellipsis",
		(stream) => {
			const prefix = "t".repeat(239);
			const event = mapFactoryEvents(stream, [{ ...rawEvent(), title: `${prefix}🦒…tail` }])[0];
			expect(event?.title).toBe(`${prefix}🦒`);
			expect(Array.from(event?.title ?? "")).toHaveLength(240);
		},
	);
	it.each(["issues", "prs", "alerts"] as const)(
		"keeps an astral %s body at the code-point limit",
		(stream) => {
			const prefix = "b".repeat(1199);
			const body = `${prefix}🚀…tail`;
			const event = mapFactoryEvents(stream, [
				{ ...rawEvent(), body, security_advisory: { summary: body } },
			])[0];
			expect(event?.body).toBe(`${prefix}🚀`);
			expect(Array.from(event?.body ?? "")).toHaveLength(1200);
		},
	);
	it.each(["name", "tag_name"])("bounds release %s titles by code point", (field) => {
		const prefix = "r".repeat(239);
		expect(mapFactoryEvents("releases", [{ [field]: `${prefix}🦒tail` }])[0]?.title).toBe(
			`${prefix}🦒`,
		);
	});
	it("preserves exact-limit ellipses and first-line commit text", () => {
		const prefix = "c".repeat(238);
		for (const suffix of ["", "trailing"]) {
			const event = mapFactoryEvents("commits", [
				{ ...rawEvent(), commit: { message: `${prefix}🦒…${suffix}\nnot the subject` } },
			])[0];
			expect(event?.title).toBe(`${prefix}🦒…`);
			expect(Array.from(event?.title ?? "")).toHaveLength(240);
		}
	});
	it("replaces incoming lone surrogates without damaging valid emoji or short empty text", () => {
		for (const title of ["", "short…", "🦒🚀"]) {
			expect(mapFactoryEvents("issues", [{ ...rawEvent(), title }])[0]?.title).toBe(title);
		}
		const event = mapFactoryEvents("issues", [
			{ ...rawEvent(), title: "a\ud83db\udc00🦒", body: "\udc00body\ud83d" },
		])[0];
		expect(event?.title).toBe("a�b�🦒");
		expect(event?.body).toBe("�body�");
	});
	it.each(
		(
			[
				["flow array", "[\n  true,\n  false\n  ]"],
				["flow mapping", "{\n  allowed: true\n  }"],
				["inline flow array", "[true, false]"],
				["inline flow mapping", "{ allowed: true }"],
				["mapping header", "uses: fake/condition@v1"],
				["mapping continuation", "github.event_name == 'push'\n  uses: fake/condition@v1"],
				[
					"later mapping continuation",
					"\n  github.event_name == 'push'\n  uses: fake/condition@v1",
				],
				["sequence continuation", "github.event_name == 'push'\n  - true"],
				["comment-ended continuation", "github.event_name == 'push' # done\n  && true"],
				["comment-interrupted continuation", "github.event_name == 'push'\n  # done\n  && true"],
			] as const
		).flatMap(([shape, condition]) => [false, true].map((step) => ({ shape, condition, step }))),
	)("rejects ambiguous plain conditions ($shape, step=$step)", ({ condition, step }) => {
		const text = step
			? `jobs:\n  build:\n    steps:\n      - if: ${condition.replaceAll("\n", "\n        ")}\n        uses: actions/checkout@v4`
			: `jobs:\n  build:\n    if: ${condition.replaceAll("\n", "\n    ")}\n    uses: nocoo/base-ci/.github/workflows/deploy.yml@main`;
		expect(() => mapDependencies({ ci: { text } }, mapFactoryRepo(rawRepo))).toThrow();
	});
	it.each(["", "# condition"])(
		"rejects non-scalar children after an empty/comment-only if (%s)",
		(value) => {
			for (const child of [
				"uses: fake/action@v1",
				"- uses: fake/action@v1",
				"*shared",
				"{ uses: fake/action@v1 }",
			])
				for (const step of [false, true]) {
					const text = step
						? `jobs:\n  build:\n    steps:\n      - if: ${value}\n          ${child}\n        uses: actions/checkout@v4`
						: `jobs:\n  build:\n    if: ${value}\n      ${child}\n    uses: nocoo/base-ci/.github/workflows/deploy.yml@main`;
					expect(() => mapDependencies({ ci: { text } }, mapFactoryRepo(rawRepo))).toThrow();
				}
		},
	);
	it("accepts a comment-only if header followed by a plain condition scalar", () => {
		expect(
			mapDependencies(
				{
					release: {
						text: "jobs:\n  deploy:\n    if: # condition\n      github.event_name == 'push'\n        && github.ref == 'refs/heads/main'\n    uses: nocoo/base-ci/.github/workflows/deploy.yml@main",
					},
				},
				mapFactoryRepo(rawRepo),
			).items,
		).toHaveLength(1);
	});
	it.each(["plain", "|", ">-", "|2-", ">+2", "empty"])(
		"scans job and step multiline if values (%s) without interpreting their contents",
		(header) => {
			const text = multilineReleaseWorkflow.replace(
				/^([ ]*(?:- )?)if: (.*)/gm,
				(_, indent: string, value: string) =>
					header === "plain"
						? `${indent}if: ${value}`
						: `${indent}if: ${header === "empty" ? "" : header}\n${" ".repeat(indent.length)}  ${value}`,
			);
			const items = mapDependencies({ release: { text } }, mapFactoryRepo(rawRepo)).items;
			expect(items.map(({ id, job }) => ({ id, job }))).toEqual([
				{
					id: ".github/workflows/release.yml:nocoo/base-ci/.github/workflows/deploy.yml#job=deploy",
					job: "deploy",
				},
				{ id: ".github/workflows/release.yml:actions/checkout#job=verify", job: "verify" },
				{ id: ".github/workflows/release.yml:actions/cache#job=verify", job: "verify" },
			]);
		},
	);
	it.each(["|", ">-"])("ignores nested keys in %s condition block scalars", (header) => {
		const text = `jobs:
  deploy:
    if: ${header}
      github.event_name == 'push'
      uses: fake/condition@v1
      jobs:
        fake:
          uses: fake/job@v1
    uses: nocoo/base-ci/.github/workflows/deploy.yml@main
  verify:
    steps:
      - if: ${header}
          github.event_name == 'push'
          uses: fake/step@v1
        uses: actions/checkout@v4
`;
		expect(
			mapDependencies({ ci: { text } }, mapFactoryRepo(rawRepo)).items.map((item) => item.title),
		).toEqual(["nocoo/base-ci/.github/workflows/deploy.yml", "actions/checkout"]);
	});
	it.each(["", "# condition", "${{", "github.event_name == 'push'"])(
		"preserves valid plain continuations after %s headers",
		(header) => {
			const expression = [
				header,
				"",
				...(header === "github.event_name == 'push'" ? [] : ["  github.event_name == 'push'"]),
				"  && contains('https://example.test', ':')",
				...(header === "${{" ? ["  }}"] : []),
			].join("\n");
			for (const step of [false, true]) {
				const text = step
					? `jobs:\n  build:\n    steps:\n      - if: ${expression.replaceAll("\n", "\n        ")}\n        uses: actions/checkout@v4`
					: `jobs:\n  build:\n    if: ${expression.replaceAll("\n", "\n    ")}\n    uses: nocoo/base-ci/.github/workflows/deploy.yml@main`;
				expect(mapDependencies({ ci: { text } }, mapFactoryRepo(rawRepo)).items).toHaveLength(1);
			}
		},
	);
	it.each([0, 2, 4])("finds jobs at the document root indentation of %s spaces", (indent) => {
		const text = dependencyWorkflow
			.split("\n")
			.map((line) => " ".repeat(indent) + line)
			.join("\n");
		expect(
			mapDependencies(
				{ ci: { text: `# comment at column zero\n---\n${text}` } },
				mapFactoryRepo(rawRepo),
			),
		).toEqual(mapDependencies({ ci: { text: dependencyWorkflow } }, mapFactoryRepo(rawRepo)));
	});
	it("distinguishes a parsed run-only job from missing workflow evidence", () => {
		expect(
			mapDependencies(
				{ ci: { text: "  jobs:\n    build:\n      steps:\n        - run: echo hello" } },
				mapFactoryRepo(rawRepo),
			),
		).toEqual({ items: [], manifests: [] });
	});
	it("accepts complete single-line quoted scalars without reading their contents", () => {
		const text = `jobs:
  build:
    steps:
      - name: "Checkout \\"code\\"" # uses: fake/comment@v1
        uses: "actions/checkout@v4"
      - run: 'echo ''hello'' uses: fake/script@v1' # complete scalar
`;
		expect(
			mapDependencies({ ci: { text } }, mapFactoryRepo(rawRepo)).items.map((item) => item.title),
		).toEqual(["actions/checkout"]);
	});
	it("handles a byte-order mark and document terminator without losing the root", () => {
		expect(
			mapDependencies(
				{ ci: { text: `\uFEFF---\n  jobs:\n    build:\n      steps: []\n...\n` } },
				mapFactoryRepo(rawRepo),
			),
		).toEqual({ items: [], manifests: [] });
	});
	it.each(["if", "name"])("retains uses after a folded step %s property", (key) => {
		const text = `jobs:
  build:
    steps:
      - ${key}: >-
          github.event_name == 'push'
        uses: actions/checkout@v4
      - uses: actions/cache@v4
`;
		expect(
			mapDependencies({ ci: { text } }, mapFactoryRepo(rawRepo)).items.map((item) => item.id),
		).toEqual([
			".github/workflows/ci.yml:actions/checkout#job=build",
			".github/workflows/ci.yml:actions/cache#job=build",
		]);
	});
	it("keeps workflow job identities unique and stable across refreshes", () => {
		const read = (text: string, head = "abc") =>
			mapDependencies({ ci: { text } }, { ...mapFactoryRepo(rawRepo), head }).items;
		const items = read(dependencyWorkflow);
		const base = ".github/workflows/ci.yml:nocoo/base-ci/.github/workflows/test-job.yml";
		expect(items.map((item) => item.id)).toEqual([
			`${base}#job=api`,
			`${base}#job=browser`,
			".github/workflows/ci.yml:actions/checkout#job=checks",
		]);
		expect(items).toMatchObject([{ job: "api" }, { job: "browser" }, { job: "checks" }]);
		expect(read(dependencyWorkflow, "new-head").map((item) => item.id)).toEqual(
			items.map((item) => item.id),
		);
		expect(
			read(
				`jobs:\n  browser:\n    uses: nocoo/base-ci/.github/workflows/test-job.yml@main\n  api:\n    uses: nocoo/base-ci/.github/workflows/test-job.yml@main`,
			)
				.map((item) => item.id)
				.sort(),
		).toEqual(
			items
				.slice(0, 2)
				.map((item) => item.id)
				.sort(),
		);
		expect(
			read(`jobs:\n  api:\n    uses: nocoo/base-ci/.github/workflows/test-job.yml@v2`)[0]?.id,
		).toBe(items[0]?.id);
	});
	it.each(["|", "|-", "|2-", "|-2", ">2+", ">+2", "|   ", ">2-   "])(
		"ignores %s scalar bodies while scanning job and step references",
		(header) => {
			const text = `name: CI
env:
  uses: outside/workflow@v1
jobs:
   "unit-tests":
     name: Display label
     uses: 'nocoo/base-ci/.github/workflows/test-job.yml@feature/x' # pinned

   'browser_tests':
     steps:
       - run: ${header}
           uses: fake/script@v1
           jobs:
             wrong:
               uses: fake/job@v1
       - run: > # folded
           uses: fake/folded@v1
       # actual action
       - name: Checkout
         uses: actions/checkout@v4
       - uses: ./local
       - uses: docker://alpine:3
permissions:
  uses: outside/end@v1
`;
			const items = mapDependencies(
				{ ci: { text: text.replaceAll("\n", "\r\n") } },
				mapFactoryRepo(rawRepo),
			).items;
			expect(items.map(({ id, job }) => ({ id, job }))).toEqual([
				{
					id: ".github/workflows/ci.yml:nocoo/base-ci/.github/workflows/test-job.yml#job=unit-tests",
					job: "unit-tests",
				},
				{ id: ".github/workflows/ci.yml:actions/checkout#job=browser_tests", job: "browser_tests" },
			]);
		},
	);
	it("normalizes private inventory, language bytes and explicit unknown languages", () => {
		expect(mapFactoryRepo(rawRepo)).toMatchObject({
			private: true,
			diskKiB: 1024,
			language: "TypeScript",
			head: "abc",
			totalCommits: 3,
			languages: [{ name: "TypeScript", bytes: 100 }],
			topics: ["cli"],
		});
		expect(mapFactoryRepo({})).toMatchObject({
			private: false,
			language: "未标记",
			branch: null,
			head: null,
			languages: [],
			totalCommits: 0,
			description: null,
		});
		expect(mapFactoryRepo({ ...rawRepo, languages: { totalCount: 101 } }).languagesComplete).toBe(
			false,
		);
		expect(object(null)).toEqual({});
		expect(object([])).toEqual({});
		expect(rows(null)).toEqual([]);
		expect(rows([null])).toEqual([{}]);
		expect(coverage().source).toBe("");
		expect(exclusion({ ...rawRepo, isArchived: true, isFork: true }, "NOCOO")).toBeNull();
	});
	it("separates issue records from PRs and preserves native author/timestamps/ids", () => {
		const rows = mapFactoryEvents("issues", [rawEvent(), { ...rawEvent(2), pull_request: {} }, {}]);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.id).toBe("N_1");
		expect(rows[1]?.author).toBe("unlinked");
		const commit = mapFactoryEvents("commits", [
			{
				sha: "abc",
				html_url: "https://github.com/nocoo/app/commit/abc",
				commit: { message: "first\nrest", committer: { date: "2026-09-01T00:00:00Z" } },
				author: { login: "nocoo" },
			},
		])[0];
		expect(commit).toMatchObject({
			id: "abc",
			title: "first",
			state: "committed",
			author: "nocoo",
		});
		expect(mapFactoryEvents("commits", [{}])[0]?.title).toBe("");
		expect(mapFactoryEvents("prs", [{ ...rawEvent(), draft: true }])[0]?.draft).toBe(true);
		expect(
			mapFactoryEvents("actions", [{ ...rawEvent(), conclusion: null, status: "queued" }])[0]
				?.conclusion,
		).toBeNull();
		expect(
			mapFactoryEvents("actions", [
				{ id: 1, actor: { login: "bot" }, name: "ci", status: "completed", conclusion: "success" },
			])[0],
		).toMatchObject({ id: "1", title: "ci", author: "bot", state: "completed" });
		expect(
			mapFactoryEvents("alerts", [
				{
					number: 4,
					dependency: { package: { name: "pkg" } },
					security_advisory: { severity: "high" },
				},
			])[0],
		).toMatchObject({ id: "4", title: "pkg · high" });
	});
	it("uses release published_at, preserving draft and prerelease distinction", () => {
		const events = mapFactoryEvents("releases", [
			{ tag_name: "v1", published_at: "2026-09-01", draft: true },
			{ prerelease: true },
			{},
		]);
		expect(events.map((r) => r.state)).toEqual(["draft", "prerelease", "published"]);
		expect(events[0]?.at).toBe("2026-09-01");
		expect(events[0]?.title).toBe("v1");
	});
	it("captures literal manifest and reusable-workflow evidence with immutable source URLs", () => {
		const repo = mapFactoryRepo(rawRepo);
		const data = mapDependencies(
			{
				package: {
					text: JSON.stringify({
						dependencies: { one: "^1", invalid: 42 },
						devDependencies: { two: "2" },
						peerDependencies: { three: "3" },
						optionalDependencies: { four: "4" },
					}),
				},
				ci: {
					text: "jobs:\n build:\n  steps:\n   - uses: nocoo/base-ci/action@abc\n   - uses: './local'",
				},
				release: {
					text: "jobs:\n build:\n  uses: 'nocoo/base-ci/.github/workflows/deploy.yml@main'",
				},
				dependabot: { text: "" },
				renovate: { text: "{}" },
			},
			repo,
		);
		expect(data.items.map((d) => d.title)).toEqual([
			"one",
			"two",
			"three",
			"four",
			"nocoo/base-ci/action",
			"nocoo/base-ci/.github/workflows/deploy.yml",
			"dependabot",
			"renovate",
		]);
		expect(data.items[0]?.url).toContain("/blob/abc/package.json#dependencies");
		expect(mapDependencies({}, repo)).toEqual({ items: [], manifests: [] });
		expect(() => mapDependencies({ package: { text: "{" } }, repo)).toThrow();
	});
	it("separates package identity from dependencies and keeps unknown event metadata null", () => {
		const evidence = mapDependencies(
			{
				package: {
					text: JSON.stringify({
						name: "@scope/own",
						version: "1.2.3",
						dependencies: { "@scope/own": "workspace:*", external: "^2", app: "3" },
					}),
				},
			},
			mapFactoryRepo(rawRepo),
		);
		expect(evidence.items.map((item) => item.title)).toEqual(["external", "app"]);
		expect(evidence.items[0]).toMatchObject({ at: null, createdAt: null, author: null });
		expect(evidence.manifests).toEqual([
			{
				name: "@scope/own",
				version: "1.2.3",
				path: "package.json",
				url: "https://github.com/nocoo/app/blob/abc/package.json#name",
			},
		]);
	});
	it("preserves configuration evidence when the root package has the same name", () => {
		const evidence = mapDependencies(
			{
				package: { text: JSON.stringify({ name: "renovate", dependencies: { renovate: "1" } }) },
				renovate: { text: "{}" },
			},
			mapFactoryRepo(rawRepo),
		);
		expect(evidence.items).toMatchObject([
			{ title: "renovate", path: "renovate.json", version: "configured" },
		]);
	});
});
