import { expect, test } from "bun:test";
import { ServiceRoute } from "@lando/sdk/schema";
import { Schema } from "effect";

const common = {
  protocol: "http",
  pathPrefix: "/api",
  endpoint: { port: 8080, transport: "tcp", names: ["web"], primary: true },
} as const;
const exact = { ...common, host: "app.test", hostMatch: "exact" } as const;
const pattern = { ...common, host: "*.app.test", hostMatch: "pattern" } as const;
const pending = { binding: "pending", state: "inactive" } as const;
const assigned = { binding: "assigned", port: 38080, state: "active" } as const;
const exactAssigned = { ...exact, ...assigned, url: "http://app.test:38080/api" } as const;
const patternAssigned = { ...pattern, ...assigned } as const;
const { pathPrefix: _path, ...withoutPath } = exact;
const { hostMatch: _hostMatch, ...withoutHostMatch } = exactAssigned;
const decode = Schema.decodeUnknownSync(ServiceRoute);

test.each([exactAssigned, { ...exact, ...pending }, patternAssigned, { ...pattern, ...pending }])(
  "round trips a service route: %j",
  (row) => {
    expect(Schema.encodeSync(ServiceRoute)(decode(row, { onExcessProperty: "error" }))).toEqual(row);
  },
);

test.each([
  ["pattern URL", { ...patternAssigned, url: "http://*.app.test:38080/api" }],
  ["pending port", { ...exact, ...pending, port: 38080 }],
  ["pending activity", { ...pattern, ...pending, state: "active" }],
  ["pending URL", { ...exact, ...pending, url: exactAssigned.url }],
  ["missing assigned exact URL", { ...exact, ...assigned }],
  ["exact wildcard host", { ...exactAssigned, host: "*.app.test" }],
  ["pattern concrete host", { ...patternAssigned, host: "app.test" }],
  ["non-HTTP protocol", { ...exact, ...pending, protocol: "udp" }],
  ["missing path prefix", { ...withoutPath, ...pending }],
  ["missing host match", withoutHostMatch],
] as const)("rejects a route with %s even with permissive decoding", (_reason, row) => {
  expect(() => decode(row)).toThrow();
});

test.each([
  ["connection scope", { ...exactAssigned, scope: "host" }],
  ["connection source", { ...exactAssigned, source: "publication" }],
  ["alternate URLs", { ...patternAssigned, alternateUrls: [] }],
] as const)("rejects an excess %s field in strict decoding", (_reason, row) => {
  expect(() => decode(row, { onExcessProperty: "error" })).toThrow();
});
