import { expect, it } from "vitest";
import { factoryCountAxisDomain, factoryCountAxisTicks } from "./factory-story";

it("keeps factory count axes readable when line values are sparse or all null", () => {
	expect(factoryCountAxisDomain([null, null])).toEqual([0, 1]);
	expect(factoryCountAxisDomain([0, null, 2])).toEqual([0, 2]);
	expect(factoryCountAxisDomain([7, 3, null])).toEqual([0, 7]);
	expect(factoryCountAxisTicks([0, 1])).toEqual([0, 1]);
	expect(factoryCountAxisTicks([0, 7])).toEqual([0, 4, 7]);
});
