import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { CommandAliasConflictError } from "@lando/sdk/errors";

import { CommandRegistrationError } from "../../src/cli/oclif/command-base.ts";

const coreRoot = resolve(import.meta.dirname, "../..");
const registryPath = resolve(coreRoot, "src/cli/built-in-command-registry.ts");

type SyntheticRegistration = {
  readonly spec: { readonly id: string };
  readonly command: { readonly aliases?: ReadonlyArray<string> };
};

type SyntheticIndex = {
  readonly entries: ReadonlyArray<SyntheticRegistration>;
  readonly byToken: ReadonlyMap<string, SyntheticRegistration>;
  readonly namespaceHeads: ReadonlySet<string>;
};

const isRegistryBuilder = (
  value: unknown,
): value is (registrations: ReadonlyArray<readonly [string, SyntheticRegistration]>) => SyntheticIndex =>
  typeof value === "function";

const syntheticRegistration = (id: string, aliases: ReadonlyArray<string> = []): SyntheticRegistration => ({
  spec: { id },
  command: { aliases },
});

describe("built-in command registry contract", () => {
  test("one registry owns canonical specs, OCLIF metadata, and implementation status", async () => {
    // Given: the canonical built-in command registry module on disk.
    const registryFile = Bun.file(registryPath);

    // When: the registry module is loaded.
    const exists = await registryFile.exists();

    // Then: every canonical command is uniquely owned and its projections agree.
    expect(exists, "built-in-command-registry.ts must own the canonical command universe").toBe(true);
    const registry = await import("../../src/cli/built-in-command-registry.ts");
    const entries = registry.builtInCommandEntries;
    const canonicalIds = entries.map((entry) => entry.spec.id);

    expect(new Set(canonicalIds).size).toBe(canonicalIds.length);
    expect(canonicalIds).toEqual([...canonicalIds].sort((left, right) => left.localeCompare(right)));
    for (const [key, entry] of Object.entries(registry.builtInCommandRegistry)) {
      expect(key).toBe(entry.spec.id);
      expect(registry.resolveBuiltInCommand(entry.spec.id)).toBe(entry);
      expect(entry.command.landoSpec).toBe(entry.spec);
      expect(entry.command.bootstrap).toBe(entry.spec.bootstrap);
      for (const alias of entry.command.aliases ?? []) {
        expect(registry.resolveBuiltInCommand(alias), `${alias} must resolve to ${entry.spec.id}`).toBe(
          entry,
        );
      }
    }

    expect(registry.deferredBuiltInCommandIds).toEqual([
      "meta:events:follow",
      "meta:plugin:login",
      "meta:plugin:logout",
    ]);
    expect(entries.filter((entry) => entry.status.kind === "deferred").map((entry) => entry.spec.id)).toEqual(
      [...registry.deferredBuiltInCommandIds],
    );
  });

  test("registry construction rejects mismatched keys and duplicate token ownership", async () => {
    // Given: synthetic registrations covering every invalid ownership shape.
    const registry = await import("../../src/cli/built-in-command-registry.ts");
    const buildIndex = Reflect.get(registry, "buildBuiltInCommandIndex");

    // When: the registry constructor is selected.
    const isBuilder = isRegistryBuilder(buildIndex);

    // Then: key/spec mismatches and every token collision are rejected at construction.
    expect(isBuilder, "built-in registry must expose its construction validator").toBe(true);
    if (!isBuilder) return;
    expect(() => buildIndex([["app:wrong", syntheticRegistration("app:right")]])).toThrow(
      CommandRegistrationError,
    );
    expect(() =>
      buildIndex([
        ["app:one", syntheticRegistration("app:one")],
        ["app:one", syntheticRegistration("app:one")],
      ]),
    ).toThrow(CommandAliasConflictError);
    expect(() =>
      buildIndex([
        ["app:one", syntheticRegistration("app:one", ["shared"])],
        ["app:two", syntheticRegistration("app:two", ["shared"])],
      ]),
    ).toThrow(CommandAliasConflictError);
    expect(() =>
      buildIndex([
        ["app:one", syntheticRegistration("app:one", ["app:two"])],
        ["app:two", syntheticRegistration("app:two")],
      ]),
    ).toThrow(CommandAliasConflictError);
  });

  test("registry construction derives reserved bare namespace heads from canonical ids and colon aliases", async () => {
    // Given
    const registry = await import("../../src/cli/built-in-command-registry.ts");
    const buildIndex = Reflect.get(registry, "buildBuiltInCommandIndex");
    expect(isRegistryBuilder(buildIndex)).toBe(true);
    if (!isRegistryBuilder(buildIndex)) return;

    // When
    const index = buildIndex([
      ["app:one", syntheticRegistration("app:one", ["one", "plugin:one", "--legacy-one"])],
      ["meta:two", syntheticRegistration("meta:two", ["global:two"])],
    ]);

    // Then
    expect([...index.namespaceHeads].sort()).toEqual(["app", "global", "meta", "plugin"]);
  });

  test("registry namespace routing reserves bare heads without reserving colon-qualified tooling ids", async () => {
    // Given
    const registry = await import("../../src/cli/built-in-command-registry.ts");

    // When / Then
    expect(registry.isReservedNamespaceHead("app")).toBe(true);
    expect(registry.isReservedNamespaceHead("plugin")).toBe(true);
    expect(registry.isReservedNamespaceHead("app:quality")).toBe(false);
  });

  test("help, schema, MCP, and native dispatch project from the registry", () => {
    // Given: help, schema, MCP allowlist, and compiled-argv consumers of the registry.
    const consumers = [
      "src/cli/compiled-argv.ts",
      "src/cli/compiled-help.ts",
      "../scripts/build-schema-snapshot.ts",
      "../scripts/build-mcp-allowlist.ts",
    ].map((path) => readFileSync(resolve(coreRoot, path), "utf-8"));

    // When: their registry dependencies are inspected.
    const registryConsumers = consumers.filter((source) => source.includes("built-in-command-registry"));

    // Then: all projections use the registry and dispatch resolves an entry before topic adapters.
    expect(registryConsumers).toHaveLength(consumers.length);
    expect(consumers.every((source) => !source.includes("oclif/compiled-commands"))).toBe(true);
  });

  test("deferred status is checked before every transitional topic dispatcher", () => {
    // Given: only the executable runCompiledCli body, excluding imports.
    const source = readFileSync(resolve(coreRoot, "src/cli/run.ts"), "utf-8");
    const functionStart = source.indexOf("const runCompiledCli =");
    const functionEnd = source.indexOf("\n};", functionStart);
    const body = source.slice(functionStart, functionEnd);

    // When: the runtime deferred gate and dispatcher call sites are located.
    const deferredGate = body.indexOf('if (builtInCommand?.status.kind === "deferred")');
    const dispatchers = [
      "dispatchAppCommand(argv)",
      "dispatchAppsCommand(argv)",
      "dispatchMetaCommand(argv)",
    ];

    // Then: the real deferred gate precedes every real topic dispatcher call.
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(deferredGate).toBeGreaterThanOrEqual(0);
    for (const dispatcher of dispatchers) {
      const call = body.indexOf(dispatcher);
      expect(call, `${dispatcher} must occur inside runCompiledCli`).toBeGreaterThanOrEqual(0);
      expect(deferredGate, `deferred status must be checked before ${dispatcher}`).toBeLessThan(call);
    }
  });
});
