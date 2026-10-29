import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { factoryFixture, savedFactoryWindow } from "../../../../../tests/fixtures/factory-snapshot";
import { repoFactorySeries } from "../viewmodels/boards";
import { RepoActivityChart } from "./repo-charts";

it.each([30, 90])("labels the repository's %i-day activity chart", (dayCount) => {
	const snapshot = factoryFixture();
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("fixture");
	const days = repoFactorySeries(repo, savedFactoryWindow(snapshot.fetched_at, dayCount));
	expect(renderToStaticMarkup(<RepoActivityChart days={days} />)).toContain(
		`aria-label="仓库 ${dayCount} 天活动"`,
	);
});
