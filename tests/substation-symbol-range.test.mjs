import test from "node:test";
import assert from "node:assert/strict";
import { groundViewExtent, withinSubstationViewExtent, SUBSTATION_VIEW_EXTENT_METERS } from "../src/spatial/substation-symbol-range.js";

test("substations appear at 1,000 feet of ground extent or below, including the exact boundary", () => {
  assert.equal(SUBSTATION_VIEW_EXTENT_METERS, 304.8);
  assert.equal(withinSubstationViewExtent(304.8), true);
  assert.equal(withinSubstationViewExtent(304.8001), false);
  for (const value of [-1, NaN, Infinity, undefined]) assert.equal(withinSubstationViewExtent(value), false);
  assert.equal(withinSubstationViewExtent(groundViewExtent([-82.459, 27.947, -82.457, 27.949])), true);
  assert.equal(withinSubstationViewExtent(groundViewExtent([-82.46, 27.947, -82.456, 27.949])), false);
  assert.equal(withinSubstationViewExtent(groundViewExtent([-82.459, 27.946, -82.457, 27.95])), false);
  assert.ok(groundViewExtent([-180, -85, 180, 85]) > 30000000);
  assert.equal(groundViewExtent(null), Infinity);
});
