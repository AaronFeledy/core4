#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { BuiltInCommandEntry } from "../core/src/cli/built-in-command-registry.ts";
import { COMMAND_TOPICS } from "../core/src/cli/command-topics.ts";
import { universalFormatFlagDefs } from "../core/src/cli/format-flags.ts";
import { resolveTopLevelAliases } from "../core/src/cli/spec/command-spec.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const CORE_ROOT = resolve(REPOSITORY_ROOT, "core");
const OUTPUT = resolve(CORE_ROOT, "src/cli/generated/command-registry-manifest.ts");
const COMMAND_IDS_OUTPUT = resolve(CORE_ROOT, "src/cli/generated/command-ids.ts");
const BOOTSTRAP_SOURCE =
  'export const COMMAND_REGISTRY_MANIFEST = { commands: {}, source: "built-in-command-registry", topics: {}, version: "0.0.0" } as const;\n';
const COMMAND_IDS_BOOTSTRAP_SOURCE = "export const BUILT_IN_COMMAND_IDS: ReadonlyArray<string> = [];\n";

const toJsonValue = (value: unknown): JsonValue | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const serialized = toJsonValue(item);
      return serialized === undefined ? [] : [serialized];
    });
  }
  if (typeof value !== "object") return undefined;

  const entries = Object.entries(value).flatMap(([key, item]) => {
    const serialized = toJsonValue(item);
    return serialized === undefined ? [] : [[key, serialized] as const];
  });
  return Object.fromEntries(entries);
};

const projectSpec = (entry: BuiltInCommandEntry): JsonValue => {
  const spec = entry.spec;
  return (
    toJsonValue({
      id: spec.id,
      summary: spec.summary,
      description: spec.summary,
      namespace: spec.namespace,
      deprecated: spec.deprecated,
      mcpAllowed: spec.mcpAllowed,
      hostProxyAllowed: spec.hostProxyAllowed,
      topLevelAlias: spec.topLevelAlias,
      aliases: spec.aliases,
      examples: spec.examples,
      hidden: spec.hidden,
      deferred: spec.deferred,
      bootstrap: spec.bootstrap,
      flags: spec.flags,
      args: spec.args,
      streamingMode: spec.streamingMode,
    }) ?? {}
  );
};

const projectCommand = (entry: BuiltInCommandEntry): JsonValue => {
  const spec = entry.spec;
  return (
    toJsonValue({
      aliases: resolveTopLevelAliases(spec),
      args: spec.args,
      description: spec.description,
      flags: { ...universalFormatFlagDefs, ...(spec.flags ?? {}) },
      hidden: spec.hidden === true,
      spec: projectSpec(entry),
      strict: spec.strict,
      summary: spec.summary,
    }) ?? {}
  );
};

const readCoreVersion = async (): Promise<string> => {
  const packageJson: unknown = await Bun.file(resolve(CORE_ROOT, "package.json")).json();
  if (
    typeof packageJson !== "object" ||
    packageJson === null ||
    !("version" in packageJson) ||
    typeof packageJson.version !== "string"
  ) {
    throw new TypeError("core/package.json is missing a string version");
  }
  return packageJson.version;
};

const renderManifestModule = (entries: readonly BuiltInCommandEntry[], version: string): string => {
  const commands = Object.fromEntries(entries.map((entry) => [entry.spec.id, projectCommand(entry)]));
  const manifest = { commands, source: "built-in-command-registry", topics: COMMAND_TOPICS, version };
  return `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-command-registry-manifest.ts\`.
 * Source of truth: \`builtInCommandEntries\` and \`COMMAND_TOPICS\`.
 */
export const COMMAND_REGISTRY_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;
`;
};

const renderCommandIdsModule = (commandIds: readonly string[]): string => `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-command-registry-manifest.ts\`.
 */
export const BUILT_IN_COMMAND_IDS = ${JSON.stringify(commandIds, null, 2)} as const;
`;

const main = async (): Promise<void> => {
  await Promise.all(
    [
      { content: BOOTSTRAP_SOURCE, path: OUTPUT },
      { content: COMMAND_IDS_BOOTSTRAP_SOURCE, path: COMMAND_IDS_OUTPUT },
    ].map(async ({ content, path }) => {
      if (await Bun.file(path).exists()) return;
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, content);
    }),
  );
  const { builtInCommandEntries } = await import("../core/src/cli/built-in-command-registry.ts");
  const version = await readCoreVersion();
  const commandIds = builtInCommandEntries.map((entry) => entry.spec.id);
  await writeFormattedOutput(OUTPUT, renderManifestModule(builtInCommandEntries, version));
  await writeFormattedOutput(COMMAND_IDS_OUTPUT, renderCommandIdsModule(commandIds));
  console.log(
    `[build-command-registry-manifest] wrote ${OUTPUT} + ${COMMAND_IDS_OUTPUT} (${commandIds.length} commands)`,
  );
};

if (import.meta.main) await main();
