import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import * as SDK from "@lando/sdk/schema";

const settings = { enabled: true, path: "/ready", okCodes: [204], retries: 2, timeoutMs: 4000 };
const metadata: typeof SDK.PlanMetadata.Encoded = {
  resolvedAt: "2026-06-14T00:00:00.000Z",
  source: ".lando.yml",
  runtime: 4,
};

describe("ScanPlan", () => {
  test.each(["enabled", "path", "okCodes", "retries", "timeoutMs"])("requires %s", (field) => {
    // Given a resolved plan missing one field.
    const input = Object.fromEntries(Object.entries(settings).filter(([key]) => key !== field));
    // When decoded, then reject the incomplete plan.
    expect(Either.isLeft(Schema.decodeUnknownEither(SDK.ScanPlan)(input))).toBe(true);
  });

  test("round-trips a decoded scanner in ServicePlan", () => {
    // Given fully resolved scanner settings.
    const scanner = Schema.decodeUnknownSync(SDK.ScanPlan)(settings);
    const service = Schema.decodeUnknownSync(SDK.ServicePlan)({
      name: "web",
      type: "test",
      provider: "docker",
      primary: true,
      environment: {},
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
      scanner,
    });
    // When encoded, then preserve the scanner settings.
    expect(Schema.encodeSync(SDK.ServicePlan)(service).scanner).toEqual(settings);
  });

  test.each([{ enabled: false }, undefined])("round-trips optional AppPlan.router %j", (router) => {
    // Given a new plan or a cached plan predating router intent.
    const input = {
      id: "myapp",
      name: "myapp",
      slug: "myapp",
      root: "/app",
      provider: "docker",
      services: {},
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
      ...(router === undefined ? {} : { router }),
    };
    // When decoded and encoded, then preserve router presence and value.
    expect(Schema.encodeSync(SDK.AppPlan)(Schema.decodeUnknownSync(SDK.AppPlan)(input))).toEqual(input);
  });
});
