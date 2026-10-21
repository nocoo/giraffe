import { expect, it } from "vitest";
import { github, memoryStore, NOW, rawEvent, ready } from "../../../../../tests/fixtures/factory";
import { collectKind } from "./collect";
import { stepFactory, streamKey } from "./factory-collect";

it.each([0, 2])(
	"uses the same explicit open Dependabot set as the factory stream (%s open)",
	async (open) => {
		const alerts = Array.from({ length: open + 6 }, (_, id) => ({
			...rawEvent(id + 1),
			id: String(id + 1),
			state: id < open ? "OPEN" : id % 2 ? "FIXED" : "DISMISSED",
			created_at: "2020-01-01T00:00:00Z",
		}));
		const gh = github((url, init) => {
			if (url.endsWith("/graphql")) {
				const query = JSON.parse(String(init?.body)).query as string;
				return Response.json({
					data: {
						repository: {
							vulnerabilityAlerts: {
								nodes: /states:\s*OPEN/.test(query)
									? alerts.filter((alert) => alert.state === "OPEN")
									: alerts,
								pageInfo: { hasNextPage: false },
							},
						},
					},
				});
			}
			if (url.includes("/dependabot/alerts")) {
				expect(new URL(url).searchParams.get("state")).toBe("open");
				return Response.json(
					alerts
						.filter((alert) => alert.state === "OPEN")
						.map((alert) => ({ ...alert, state: "open" })),
				);
			}
			return Response.json([]);
		});
		const state = ready("alerts");
		const store = memoryStore();
		await stepFactory(state, gh, "fake", store, NOW);
		const stream = await store.read(streamKey("nocoo/app", "alerts"));
		const security = await collectKind(gh, "fake", "repo:nocoo/app:security", []);
		expect(stream?.coverage).toMatchObject({ status: "complete", observed: open });
		expect(stream?.items).toHaveLength(open);
		expect(state.repos[0]?.metrics.alerts).toBe(open);
		expect(security).toMatchObject({ dependabot_open: open, truncated: false });
		expect(security.items).toHaveLength(open);
	},
);
