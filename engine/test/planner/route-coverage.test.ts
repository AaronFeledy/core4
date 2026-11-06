import { expect, test } from "bun:test";
import { httpsRouteCoverageGap } from "../../src/planner/route-coverage.ts";

test.each([
  ["app.lndo.site", "https"],
  ["*.app.lndo.site", "both"],
  ["*-app.lndo.site", "https"],
  ["wild.*.app.lndo.site", "http"],
] as const)("%s over %s needs no change", (hostname, scheme) => {
  expect(httpsRouteCoverageGap(hostname, scheme)).toBeUndefined();
});

test.each([
  ["wild.*.app.lndo.site", "https", "*.app.lndo.site"],
  ["*.*.lndo.site", "both", "*.lndo.site"],
  ["a-*.b*.app.lndo.site", undefined, "*.app.lndo.site"],
  ["app.lndo.*", "https", undefined],
] as const)("%s over %s suggests %s", (hostname, scheme, replacement) => {
  const gap = httpsRouteCoverageGap(hostname, scheme);
  expect(gap).toBeDefined();
  expect(gap?.replacement).toBe(replacement);
});
