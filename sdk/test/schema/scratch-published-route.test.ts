import { expect, test } from "bun:test";
import { ServiceRoute } from "@lando/sdk/schema";
import { ScratchPublishedRoute } from "@lando/sdk/services";
import { Schema } from "effect";

const served = { service: "web", protocol: "http", port: 38080 } as const;
const exact = { ...served, host: "web.scratch.lndo.site", hostMatch: "exact" } as const;
const url = "http://web.scratch.lndo.site:38080/hello";
const pattern = {
  ...served,
  host: "*.scratch.lndo.site",
  hostMatch: "pattern",
  pathPrefix: "",
} as const;

test.each([{ ...exact, pathPrefix: "/hello", url }, pattern])(
  "round trips a published scratch route: %j",
  (route) => {
    const decoded = Schema.decodeUnknownSync(ScratchPublishedRoute)(route, { onExcessProperty: "error" });
    expect(Schema.encodeSync(ScratchPublishedRoute)(decoded)).toEqual(route);
  },
);

test("rejects a scratch hostname pattern with a URL even with permissive decoding", () => {
  const route = { ...pattern, url: "http://*.scratch.lndo.site:38080" };
  expect(Schema.decodeUnknownResult(ScratchPublishedRoute)(route)._tag).toBe("Failure");
});

test.each([
  { ...exact, url },
  { service: "web", hostname: "web.scratch.lndo.site", scheme: "http", port: 38080, url },
])("rejects an incomplete or legacy scratch route: %j", (route) => {
  expect(Schema.decodeUnknownResult(ScratchPublishedRoute)(route, { onExcessProperty: "error" })._tag).toBe(
    "Failure",
  );
});

const serviceRoute = {
  endpoint: { port: 8080, transport: "tcp", names: [], primary: true },
  binding: "assigned",
  state: "active",
} as const;
const exactAddress = {
  ...exact,
  pathPrefix: "/hello/*",
  url: "http://web.scratch.lndo.site:38080/hello/*",
} as const;

test.each([
  [
    "exact",
    { ...exactAddress, host: "*.scratch.lndo.site", url: "http://*.scratch.lndo.site:38080/hello/*" },
  ],
  ["pattern", { ...pattern, host: "web.scratch.lndo.site" }],
] as const)("rejects a host inconsistent with hostMatch %s on both route surfaces", (_match, route) => {
  const { service: _, ...address } = route;
  const row = { ...serviceRoute, ...address };
  expect({
    serviceRoute: Schema.decodeUnknownResult(ServiceRoute)(row)._tag,
    scratch: Schema.decodeUnknownResult(ScratchPublishedRoute)(route)._tag,
  }).toEqual({ serviceRoute: "Failure", scratch: "Failure" });
});

test("both exact route surfaces accept an asterisk only in the path prefix", () => {
  const { service: _, ...address } = exactAddress;
  const row = { ...serviceRoute, ...address };
  expect(Schema.decodeUnknownSync(ServiceRoute)(row, { onExcessProperty: "error" })).toEqual(row);
  const scratch = Schema.decodeUnknownSync(ScratchPublishedRoute)(exactAddress, {
    onExcessProperty: "error",
  });
  expect(Schema.encodeSync(ScratchPublishedRoute)(scratch)).toEqual(exactAddress);
});
