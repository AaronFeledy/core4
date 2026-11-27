import { expect, test } from "bun:test";
import { RouteHostname } from "@lando/sdk/schema";
import { Schema } from "effect";
import { suffixScratchHostname } from "../../src/scratch-app/hostnames.ts";

const id = "scratch-demo-123456";
const longestId = `scratch-${"a".repeat(25)}-123456`;

test.each([id, longestId])("suffixes every DNS label length without losing attribution (%s)", (scratchId) => {
  const rewritten = new Set<string>();
  for (let length = 1; length <= 63; length++) {
    const hostname = `${"a".repeat(length)}.lndo.site`;
    const result = suffixScratchHostname(hostname, scratchId, "lndo.site");
    if (result === undefined) throw new TypeError(`Could not suffix ${hostname}`);
    expect(Schema.is(RouteHostname)(result)).toBe(true);
    expect(result).toEndWith(`--${scratchId}.lndo.site`);
    expect(suffixScratchHostname(result, scratchId, "lndo.site")).toBe(result);
    rewritten.add(result);
  }
  expect(rewritten.size).toBe(63);
});

test.each([
  ["admin.app.lndo.site", "lndo.site", `admin.app--${id}.lndo.site`],
  ["*.app.lndo.site", "lndo.site", `*.app--${id}.lndo.site`],
  [`app--${id}.lndo.site`, "lndo.site", `app--${id}.lndo.site`],
  [`web.${id}.lndo.site`, "lndo.site", `web.${id}.lndo.site`],
  ["admin.app.dev.example.test", "dev.example.test", `admin.app--${id}.dev.example.test`],
  [`web.${id}.dev.example.test`, "dev.example.test", `web.${id}.dev.example.test`],
] as const)("suffixes the app label of %s", (hostname, domain, expected) => {
  expect(suffixScratchHostname(hostname, id, domain)).toBe(expected);
});

test("budgets against the whole hostname, not just the label", () => {
  const domain = ["a".repeat(61), "b".repeat(61), "c".repeat(61), "d".repeat(13)].join(".");
  const hostname = `${"x".repeat(50)}.${domain}`;
  const result = suffixScratchHostname(hostname, longestId, domain);
  expect(Schema.is(RouteHostname)(result)).toBe(true);
  expect(result).toEndWith(`--${longestId}.${domain}`);
});
