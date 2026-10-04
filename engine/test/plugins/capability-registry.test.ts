import { expect, test } from "bun:test";
import { ProxyError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import { indexContributions, selectRegistration } from "../../src/plugins/capability-registry.ts";
import { makePluginCapabilityIndex } from "../../src/plugins/module-set.ts";

const moduleFor = (name: string, ids: readonly string[]): LandoPluginModule => {
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name,
    version: "1.0.0",
    api: 4,
    contributes: { routerServices: ids.map((id) => ({ id, module: "./router.ts" })) },
  });
  return {
    name: manifest.name,
    manifest,
    routerServices: new Map(
      ids.map((id) => [id, { make: () => Layer.succeed(RouterService, makeTestRouterService()) }]),
    ),
  };
};

test("indexContributions preserves module and descriptor registration order", async () => {
  const modules = [moduleFor("first", ["z", "a"]), moduleFor("second", ["m"])];
  const registrations = await Effect.runPromise(
    indexContributions(modules, "routerServices", (error) => error),
  );
  expect([...registrations.keys()]).toEqual(["z", "a", "m"]);
  expect(registrations.get("z")).toBe(modules[0]?.routerServices?.get("z"));
});

test("indexContributions routes duplicate id failures through onIndexError without choosing a winner", async () => {
  const modules = [moduleFor("first", ["same"]), moduleFor("second", ["same"])];
  const original = makePluginCapabilityIndex(modules);
  expect(Result.isFailure(original)).toBe(true);
  if (!Result.isFailure(original)) return;
  const mapped = new ProxyError({ message: "index failed", proxyId: "test", cause: original.failure });
  const seen: unknown[] = [];
  const result = await Effect.runPromise(
    indexContributions(modules, "routerServices", (error) => {
      seen.push(error);
      return mapped;
    }).pipe(Effect.result),
  );
  expect(seen).toEqual([original.failure]);
  expect(result).toEqual(Result.fail(mapped));
  expect(original.failure._tag).toBe("PluginDescriptorMismatchError");
});

test("indexContributions routes descriptor mismatches through onIndexError", async () => {
  const module = moduleFor("broken", ["declared"]);
  const failure = new ProxyError({ message: "descriptor failed", proxyId: "test" });
  const result = await Effect.runPromise(
    indexContributions([{ ...module, routerServices: new Map() }], "routerServices", () => failure).pipe(
      Effect.result,
    ),
  );
  expect(result).toEqual(Result.fail(failure));
});

test("selectRegistration returns the requested id and original registration", async () => {
  const registration = { value: 1 };
  const selected = await Effect.runPromise(
    selectRegistration({
      registrations: new Map([["present", registration]]),
      id: "present",
      onMissing: (id) => new ProxyError({ message: "missing", proxyId: id }),
    }),
  );
  expect(selected.id).toBe("present");
  expect(selected.registration).toBe(registration);
});

test("selectRegistration forwards a missing id to the caller error factory", async () => {
  const result = await Effect.runPromise(
    selectRegistration({
      registrations: new Map([["other", { value: 1 }]]),
      id: "missing",
      onMissing: (id) => new ProxyError({ message: "not installed", proxyId: id }),
    }).pipe(Effect.result),
  );
  expect(result).toEqual(Result.fail(new ProxyError({ message: "not installed", proxyId: "missing" })));
});
