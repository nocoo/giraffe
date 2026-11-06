// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EmptyState } from "./empty-state";

it("renders the complete empty-state contract and preserves caller styling", () => {
	const html = renderToStaticMarkup(
		<EmptyState
			icon={<span>icon</span>}
			title="No matching records"
			description="Try another filter."
			action={<button type="button">Clear filter</button>}
			className="caller-class"
		/>,
	);

	expect(html).toContain("icon");
	expect(html).toContain("No matching records");
	expect(html).toContain("Try another filter.");
	expect(html).toContain("Clear filter");
	expect(html).toContain("h-full");
	expect(html).toContain("min-h-[var(--giraffe-empty-min-height,70vh)]");
	expect(html).toContain("justify-center");
	expect(html).toContain("caller-class");
});

it("allows callers to override the shared minimum height", () => {
	const html = renderToStaticMarkup(
		<EmptyState className="[--giraffe-empty-min-height:16rem]" title="Compact empty state" />,
	);

	expect(html).toContain("[--giraffe-empty-min-height:16rem]");
	expect(html).toContain("min-h-[var(--giraffe-empty-min-height,70vh)]");
});
