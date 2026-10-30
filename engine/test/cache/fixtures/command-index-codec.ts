import { serialize } from "node:v8";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { sha256Hex } from "@lando/sdk/digest";
import { ToolingInputDeclaration } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import type { AppCommandIndexPayload, PluginCommandIndexPayload } from "../../../src/cache/command-index.ts";

export const input = Result.getOrThrowWith(
  normalizeToolingInput("deploy", {
    flags: {
      environment: { alias: "e", choices: ["dev", "prod"], default: "dev", description: "Environment" },
      force: { boolean: true, default: false },
      token: { sensitive: true },
    },
    args: {
      target: { order: 0, required: true, choices: ["web", "worker"] },
      count: { order: 1, default: 2, description: "Count" },
    },
  }),
  (error) => error,
);
export const encodedInput = Schema.encodeSync(ToolingInputDeclaration)(input);
export const entry = { id: "app:deploy", summary: "Deploy", hidden: false, service: "appserver", input };
export const app = {
  schemaVersion: 6,
  landoVersion: "4.0.0",
  appName: "codec",
  sourceFile: "/app/.lando.yml",
  sourceContentHash: sha256Hex("name: codec\n"),
  sourceLocalIncludePaths: ["/app/.lando.local.yml"],
  sourceReferencedFiles: [
    { absolutePath: "/app/value.txt", size: 5, mtimeMs: 10, sha256: sha256Hex("value") },
  ],
  sourceScripts: [{ relativePath: ".lando/scripts/check.bun.sh", sha256: sha256Hex("metadata") }],
  sourceMtimeMs: 10,
  sourceSize: 12,
  versionConstraints: [{ range: ">=4", source: "/app/.lando.yml", layer: "canonical", order: 3 }],
  toolingFingerprint: sha256Hex("tooling"),
  entriesFingerprint: sha256Hex("entries"),
  aliasPolicy: { enabled: true, disabled: ["deploy"], custom: { ship: "deploy" } },
  generatedAtMs: 20,
  entries: [entry, { id: "app:check", summary: "Check", hidden: true, source: "bun-script" }],
} satisfies AppCommandIndexPayload;
export const plugin = {
  schemaVersion: 6,
  landoVersion: "4.0.0",
  pluginNames: ["@lando/example"],
  pluginListSha: sha256Hex("plugins"),
  commandsByPlugin: { "@lando/example": ["app:deploy"] },
  manifestFingerprint: sha256Hex("manifest"),
  generatedAtMs: 20,
  entries: [entry],
} satisfies PluginCommandIndexPayload;

// Deliberately bypass the typed encoder to model untrusted persisted v8 objects.
export const abi6Bytes = (magic: "LCAC" | "LCPC", payload: unknown): Uint8Array => {
  const header = Buffer.alloc(12);
  header.write(magic);
  header.writeBigUInt64LE(6n, 4);
  return Buffer.concat([header, serialize(payload)]);
};

export const without = (value: object, key: string): object =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
