import { expect, test } from "bun:test";
import { InfoAppResult } from "@lando/sdk/schema";
import { Schema } from "effect";

const service = {
  app: "demo",
  service: "appserver",
  api: 4,
  type: "php:8.3",
  provider: "test",
  primary: true,
  status: "stopped",
  connections: [],
} as const;

const decode = Schema.decodeUnknownSync(InfoAppResult);

test.each([
  { user: "app", password: "[REDACTED]", database: "app" },
  { user: "app", password: "[REDACTED]", database: "app", rootPassword: "[REDACTED]" },
  { engine: "sqlite", path: "data/site.sqlite" },
])("public app info preserves display credentials %j", (creds) => {
  const input = { app: "demo", services: [{ ...service, creds }] };
  const decoded = decode(input, { onExcessProperty: "error" });
  expect(Schema.encodeSync(InfoAppResult)(decoded)).toEqual(input);
});

test.each([
  { engine: "sqlite", path: "data/site.sqlite", user: "app" },
  { engine: "sqlite" },
  { engine: "sqlite", path: "data/site.sqlite", password: "[REDACTED]" },
])("public app info rejects mixed or incomplete SQLite credentials %j", (creds) => {
  expect(() =>
    decode({ app: "demo", services: [{ ...service, creds }] }, { onExcessProperty: "error" }),
  ).toThrow();
});

test("SQLite credentials do not allow unrelated app-result fields", () => {
  expect(() =>
    decode(
      {
        app: "demo",
        services: [{ ...service, creds: { engine: "sqlite", path: "data/site.sqlite" } }],
        unexpected: true,
      },
      { onExcessProperty: "error" },
    ),
  ).toThrow();
});
