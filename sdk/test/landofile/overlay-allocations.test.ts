import { expect, test } from "bun:test";
import { mergeValues, override, reset } from "@lando/sdk/landofile";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";

test.each([1, 100, 1000])("untracked mapping merge allocates no provenance maps for %i keys", (size) => {
  // Given: resolve schema rules before measuring input-dependent allocations.
  const environment = Object.fromEntries(Array.from({ length: size }, (_, i) => [`KEY${i}`, String(i)]));
  const left = { environment };
  const right = { environment: { KEY0: "new" } };
  mergeValues(Schema.Unknown, left, right);
  const OriginalMap = globalThis.Map;
  let constructions = 0;
  const CountingMap = new Proxy(OriginalMap, {
    construct(target, args) {
      constructions++;
      return Reflect.construct(target, args);
    },
  });
  // When
  globalThis.Map = CountingMap;
  let result: unknown;
  try {
    result = mergeValues(Schema.Unknown, left, right);
  } finally {
    globalThis.Map = OriginalMap;
  }
  // Then
  expect(constructions).toBe(0);
  expect(result).toEqual({ environment: { ...environment, KEY0: "new" } });
});

test("untracked keyed and directive paths allocate no provenance maps", () => {
  // Given
  const left = {
    dependsOn: { database: { condition: "service_started" } },
    routes: [{ hostname: "web.test", scheme: "both", endpoint: 80 }],
    environment: { OLD: "old" },
  };
  const right = {
    dependsOn: [{ service: "cache" }],
    routes: [{ hostname: "web.test", scheme: "http", endpoint: 8080 }],
    environment: override({ OLD: reset(), NEW: "new" }),
  };
  mergeValues(ServiceConfig, left, right);
  const OriginalMap = globalThis.Map;
  let constructions = 0;
  const CountingMap = new Proxy(OriginalMap, {
    construct(target, args) {
      constructions++;
      return Reflect.construct(target, args);
    },
  });
  // When
  globalThis.Map = CountingMap;
  let result: unknown;
  try {
    result = mergeValues(ServiceConfig, left, right);
  } finally {
    globalThis.Map = OriginalMap;
  }
  // Then
  expect(constructions).toBe(0);
  expect(result).toEqual({
    dependsOn: [{ service: "database", condition: "service_started" }, { service: "cache" }],
    routes: [
      { hostname: "web.test", scheme: "http", endpoint: 8080 },
      { hostname: "web.test", scheme: "https", endpoint: 80 },
    ],
    environment: { NEW: "new" },
  });
});
