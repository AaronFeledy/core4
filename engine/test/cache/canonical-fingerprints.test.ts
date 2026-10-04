import { expect, test } from "bun:test";
import { sha256Hex } from "@lando/sdk/digest";
import { PluginName } from "@lando/sdk/schema";
import { deriveAppPlanCacheKey } from "../../src/cache/app-plan.ts";
import { canonicalCacheJson } from "../../src/cache/canonical.ts";
import {
  deriveAppCommandEntriesFingerprint,
  derivePluginCommandPluginListSha,
} from "../../src/cache/command-index.ts";
import { fingerprintPlanningRuntimeParts } from "../../src/cache/planning-runtime.ts";
import { CORE_VERSION } from "../../src/version.ts";

test("emits fixed UTF-16 bytes when cache objects contain numeric and multilingual keys", () => {
  const input = { "2": "two", "10": "ten", a: 2, B: 1, é: 4, 日本: 3 };
  const text = canonicalCacheJson(input);
  expect(text).toBe('{"10":"ten","2":"two","B":1,"a":2,"é":4,"日本":3}');
});

test("normalizes native dates and bigint without invoking arbitrary toJSON", () => {
  let called = false;
  const value = {
    date: new Date("2026-10-02T00:00:00Z"),
    integer: 12345678901234567890n,
    custom: {
      value: "kept",
      toJSON: () => {
        called = true;
        return "replaced";
      },
    },
  };
  const text = canonicalCacheJson(value);
  expect(text).toBe(
    '{"custom":{"toJSON":null,"value":"kept"},"date":"2026-10-02T00:00:00.000Z","integer":"12345678901234567890"}',
  );
  expect(called).toBe(false);
});

test("nulls sparse cache array slots when holes survive local normalization", () => {
  const input: unknown[] = Array(3);
  input[1] = undefined;
  const text = canonicalCacheJson({ values: input, omitted: undefined });
  expect(text).toBe('{"values":[null,null,null]}');
});

test("hashes canonical text when planning runtime keys have numeric names", () => {
  const parts = { coreVersion: "test", "2": "two", "10": "ten", a: 2, B: 1 };
  const fingerprint = fingerprintPlanningRuntimeParts(parts);
  expect(fingerprint).toBe(sha256Hex('{"10":"ten","2":"two","B":1,"a":2,"coreVersion":"test"}'));
});

test("sorts manifest sets by UTF-16 when names differ by case and non-ASCII characters", () => {
  const manifests = ["é", "a", "B", "日本"].map((name) => ({
    name: PluginName.make(name),
    version: "1",
    api: 4 as const,
    bootstrap: "app" as const,
  }));
  const fingerprint = derivePluginCommandPluginListSha(manifests);
  expect(fingerprint).toBe(
    sha256Hex(
      '[{"api":4,"name":"B","version":"1"},{"api":4,"name":"a","version":"1"},{"api":4,"name":"é","version":"1"},{"api":4,"name":"日本","version":"1"}]',
    ),
  );
});

test("preserves command entry order when fingerprinting a semantic array", () => {
  const entries = [
    { id: "B", summary: "", hidden: false },
    { id: "a", summary: "", hidden: false },
  ];
  const reversed = deriveAppCommandEntriesFingerprint([...entries].reverse());
  expect(reversed).not.toBe(deriveAppCommandEntriesFingerprint(entries));
});

test("shares native date and bigint normalization across app-plan and command caches", () => {
  const input = {
    appRoot: "/app",
    landofile: { name: "app" },
    pluginManifests: [],
    planningRuntime: "fixed",
  };
  const native = deriveAppPlanCacheKey({
    ...input,
    config: { date: new Date("2026-10-02T00:00:00Z"), integer: 42n },
  });
  const normalized = deriveAppPlanCacheKey({
    ...input,
    config: { date: "2026-10-02T00:00:00.000Z", integer: "42" },
  });
  expect(native).toBe(normalized);
  const nativeEntries = [
    { id: "app:test", hidden: false, summary: "", stamp: new Date("2026-10-02T00:00:00Z"), integer: 42n },
  ];
  const normalizedEntries = [
    { id: "app:test", hidden: false, summary: "", stamp: "2026-10-02T00:00:00.000Z", integer: "42" },
  ];
  expect(deriveAppCommandEntriesFingerprint(nativeEntries)).toBe(
    deriveAppCommandEntriesFingerprint(normalizedEntries),
  );
});

test("sorts referenced-file sets by UTF-16 while omitting their modification times", () => {
  const input = {
    appRoot: "/app",
    landofile: { name: "app" },
    pluginManifests: [],
    planningRuntime: "fixed",
    sourceFingerprint: {
      landofileContentHashes: [],
      includeLockfileHash: null,
      includedFragmentShas: [],
      referencedFiles: [
        { absolutePath: "/a", size: 1, sha256: "a", mtimeMs: 100 },
        { absolutePath: "/B", size: 1, sha256: "B", mtimeMs: 200 },
      ],
    },
  };
  const fingerprint = deriveAppPlanCacheKey(input);
  expect(fingerprint).toBe(
    sha256Hex(
      `{"appRoot":"/app","cache":"app-plan","config":null,"includedFragmentShas":[],"landoVersion":${JSON.stringify(CORE_VERSION)},"landofile":{"name":"app"},"planningRuntime":"fixed","pluginManifests":[],"schemaVersion":19,"serviceInputs":{},"sourceFingerprint":{"includeLockfileHash":null,"includeSources":[],"includedFragmentShas":[],"landofileContentHashes":[],"referencedFiles":[{"absolutePath":"/B","sha256":"B","size":1},{"absolutePath":"/a","sha256":"a","size":1}]},"versionConstraints":[]}`,
    ),
  );
});
