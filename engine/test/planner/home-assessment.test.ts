import { expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { assessServiceHome } from "../../src/planner/home-assessment.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

test.each([
  [{ type: "mariadb:11.4" }, { kind: "persisted", target: "/root" }],
  [
    { type: "mariadb:11.4", image: "custom:1" },
    { kind: "not-persisted", reason: "custom-image" },
  ],
  [
    { type: "mariadb:11.4", image: "mariadb:11.4" },
    { kind: "persisted", target: "/root" },
  ],
  [
    { type: "mariadb:11.4", image: "docker.io/library/mariadb:11.4" },
    { kind: "persisted", target: "/root" },
  ],
  [
    { type: "mariadb:11.4", user: "nobody:staff" },
    { kind: "not-persisted", reason: "undeclared-user", user: "nobody" },
  ],
  [
    { type: "mariadb:11.4", user: "root:staff" },
    { kind: "persisted", target: "/root" },
  ],
  [{ type: "compose" }, { kind: "not-persisted", reason: "no-identity" }],
  [
    { type: "unknown-service" },
    { kind: "unresolved", reason: "service type unknown-service could not be resolved" },
  ],
  [{ type: "{{ env.TYPE }}" }, { kind: "unresolved", reason: "type is expression-valued" }],
  [
    { type: "mariadb:11.4", image: "{{ env.IMAGE }}" },
    { kind: "unresolved", reason: "image is expression-valued" },
  ],
  [
    { type: "mariadb:11.4", user: "{{ env.USER }}" },
    { kind: "unresolved", reason: "user is expression-valued" },
  ],
  [
    { type: "mariadb:unsupported" },
    { kind: "unresolved", reason: "service type mariadb:unsupported could not be resolved" },
  ],
] as const)("assesses catalog home for %j", async (config, expected) => {
  // Given
  const { user, ...rest } = { user: undefined, ...config };
  const service = {
    ...Schema.decodeUnknownSync(ServiceConfig)(rest),
    ...(user === undefined ? {} : { user }),
  };
  // When
  const result = await Effect.runPromise(
    Effect.flatMap(PluginRegistry, (registry) => assessServiceHome(registry, "database", service)).pipe(
      Effect.provide(PluginRegistryLayer.layerWith({ user: false, app: false })),
    ),
  );
  // Then
  expect(result).toEqual(expected);
});
