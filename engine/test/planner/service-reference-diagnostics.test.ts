import { expect, test } from "bun:test";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { PluginRegistry } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { resolveLandofileForPlanning } from "../../src/planner/event-set.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";

const root = "/srv/service-reference-diagnostics";
const registry = Registry.layerWith({ app: false, user: false });
const referenceFailure = async (services: LandofileShape["services"]) => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* resolveLandofileForPlanning({
        landofile: yield* compileTestLandofile({ name: "reference-diagnostics", services }, root),
        pluginRegistry: yield* PluginRegistry,
        configService: undefined,
        fileSystem: undefined,
        pathsService: undefined,
      }).pipe(Effect.result);
    }).pipe(Effect.provide(registry)),
  );
  if (Result.isFailure(result) && result.failure instanceof ConfigExpressionError) return result.failure;
  throw new TypeError("Expected a ConfigExpressionError");
};

test.each([
  {
    label: "exact own-port read in argv",
    service: { type: "redis", command: ["redis-server", "{{ services.cache.port }}"] },
    field: ["command", 1],
    hint: true,
  },
  {
    label: "exact own-port read beside an unrelated interpolation",
    service: { type: "redis", command: "redis-server --port {{ services.cache.port }} # {{ app.name }}" },
    field: ["command"],
    hint: true,
  },
  {
    label: "own credentials",
    service: { type: "redis", environment: { SELF: "{{ services.cache.creds.user }}" } },
    field: ["environment", "SELF"],
    hint: false,
  },
  {
    label: "own port in map-form environment",
    service: { type: "redis", environment: { SELF: "{{ services.cache.port }}" } },
    field: ["environment", "SELF"],
    hint: true,
  },
  {
    label: "own port without a planned listener",
    service: { type: "php:8.4", via: "cli", command: "php -S {{ services.cache.port }}" },
    field: ["command"],
    hint: false,
  },
  {
    label: "nested member of own port",
    service: { type: "redis", command: "{{ services.cache.port.other }}" },
    field: ["command"],
    hint: false,
  },
  {
    label: "own port at a host readiness site",
    service: {
      type: "redis",
      readiness: {
        kind: "command" as const,
        target: "host" as const,
        command: "echo {{ services.cache.port }}",
      },
    },
    field: ["readiness", "command"],
    hint: false,
  },
])("locates $label and only suggests an admitted replacement", async ({ service, field, hint }) => {
  const error = await referenceFailure({ [ServiceName.make("cache")]: service });

  const path = ["services", "cache", ...field];
  expect(error).toMatchObject({
    _tag: "ConfigExpressionError",
    path,
    source: { path },
    expression: expect.stringContaining("services.cache."),
  });
  expect(error.remediation.includes("{{ service.port }}")).toBe(hint);
});

test("names all members of a three-service cycle, excluding a dependent declared first", async () => {
  const services = Object.fromEntries(
    Object.entries({ svcDependent: "svcA", svcA: "svcB", svcB: "svcC", svcC: "svcA" }).map(([name, peer]) => [
      ServiceName.make(name),
      { type: "redis", environment: { PEER: `{{ services.${peer}.creds.user }}` } },
    ]),
  );
  const error = await referenceFailure(services);

  const path = ["services", "svcA", "environment", "PEER"];
  expect(error).toMatchObject({ path, source: { path } });
  expect(error.message.match(/\bsvc[A-Z]\w*\b/g)?.sort()).toEqual(["svcA", "svcB", "svcC"]);
});
