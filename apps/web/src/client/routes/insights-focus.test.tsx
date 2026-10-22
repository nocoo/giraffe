import { TooltipProvider } from "@nocoo/basalt";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FocusSection } from "./insights-focus";

it("describes the current repository scope without a statistics participation layer", () => {
	const html = renderToStaticMarkup(
		<TooltipProvider>
			<FocusSection ranked={[]} findings={[]} />
		</TooltipProvider>,
	);
	expect(html).toContain("当前范围内的仓库没有触发任何关注规则。");
	expect(html).not.toContain("参与统计");
});
