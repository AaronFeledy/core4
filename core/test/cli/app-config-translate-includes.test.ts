import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigTranslateError } from "@lando/sdk/errors";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { Effect, Either, Schema } from "effect";
import { appConfigTranslateWithOwnerOnlyFileAccess as appConfigTranslate } from "../_support/private-file-access.ts";

const dirs: string[] = [];
const sourceId = ConfigTranslateSourceId.make(".lando.yml");
const original = "name: original\n";

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeApp = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-translate-includes-"));
  dirs.push(cwd);
  await Bun.write(join(cwd, ".lando.yml"), original);
  return cwd;
};

type IncludeEntries = ReadonlyArray<string | { readonly source: string; readonly kind?: string }>;

const makeTranslators = (includes: IncludeEntries): readonly ConfigTranslatorShape[] => [
  {
    id: "v3",
    summary: "Translate includes",
    inputKinds: ["lando-v3"],
    detect: () => Effect.succeed([{ translator: "v3", sourceIds: [sourceId], confidence: "exact" }]),
    translate: () =>
      Effect.succeed({
        outputs: [{ targetLayer: "canonical", fragment: { name: "demo", includes }, sourceIds: [sourceId] }],
        diagnostics: [],
        deletions: [],
      }),
  },
  {
    id: "lando4",
    summary: "Encode Landofile",
    inputKinds: ["lando-v4"],
    detect: () => Effect.succeed([]),
    translate: () => Effect.fail(new ConfigTranslateError({ message: "encoder-only" })),
    encode: ({ fragment }) =>
      Effect.succeed({
        text: emitLandofileYaml(
          Schema.decodeUnknownSync(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(fragment),
        ),
        diagnostics: [],
      }),
  },
];

const preview = async (cwd: string, source = "compose.yml") => {
  const result = await Effect.runPromise(
    appConfigTranslate({
      cwd,
      translators: makeTranslators([{ source, kind: "compose" }]),
    }),
  );
  expect(result.mode).toBe("preview");
  if (result.mode !== "preview") throw new Error("Expected preview");
  return result;
};

test("preserves the include without exposing contents when its target is a regular file", async () => {
  // Given: an opaque compose file with a unique canary.
  const cwd = await makeApp();
  const canary = `opaque-compose-${crypto.randomUUID()}`;
  await Bun.write(join(cwd, "compose.yml"), canary);
  // When: translating the include.
  const result = await preview(cwd);
  // Then: only the reference is emitted.
  expect(result.diagnostics).toEqual([]);
  expect(result.targets).toHaveLength(1);
  expect(Bun.YAML.parse(result.targets[0]?.content ?? "")).toMatchObject({
    includes: [{ source: "compose.yml", kind: "compose" }],
  });
  expect(JSON.stringify(result)).not.toContain(canary);
});

test.each([
  ["missing", "compose.yml", "target does not exist"],
  ["symlink", "compose.yml", "target is a symbolic link"],
  ["escape", "../outside.yml", "relative path inside the app root"],
  ["absolute", "/outside.yml", "relative path inside the app root"],
  ["windows", "C:\\outside.yml", "relative path inside the app root"],
  ["unc", "\\\\server\\share\\compose.yml", "relative path inside the app root"],
  ["directory", "compose.yml", "target is not a regular file"],
  ["parent-symlink", "linked/compose.yml", "target resolves outside the app root"],
])(
  "reports one unsupported diagnostic and preserves the include when %s",
  async (fixture, source, message) => {
    // Given: a missing or unsafe target.
    const cwd = await makeApp();
    if (fixture === "symlink") {
      await Bun.write(join(cwd, "real.yml"), "services: {}\n");
      await symlink(join(cwd, "real.yml"), join(cwd, source));
    }
    if (fixture === "directory") await mkdir(join(cwd, source));
    if (fixture === "parent-symlink") {
      const outside = await makeApp();
      await Bun.write(join(outside, "compose.yml"), "services: {}\n");
      await symlink(outside, join(cwd, "linked"));
    }
    // When: previewing translation.
    const result = await preview(cwd, source);
    // Then: the diagnostic blocks writing without claiming the include was dropped.
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ kind: "unsupported", sourceId, keyPath: ["includes", 0] });
    expect(result.diagnostics[0]?.message).toContain(message);
    expect(result.diagnostics[0]?.remediation).toBeTruthy();
    expect(result.diagnostics.some((diagnostic) => diagnostic.kind === "dropped")).toBe(false);
    expect(result.targets).toHaveLength(1);
    expect(Bun.YAML.parse(result.targets[0]?.content ?? "")).toMatchObject({
      includes: [{ source, kind: "compose" }],
    });
  },
);

test("refuses write without changing files when the compose target is missing", async () => {
  // Given: a translated reference to a missing file.
  const cwd = await makeApp();
  // When: writing the translation.
  const result = await Effect.runPromise(
    Effect.either(
      appConfigTranslate({
        cwd,
        write: true,
        translators: makeTranslators([{ source: "compose.yml", kind: "compose" }]),
      }),
    ),
  );
  // Then: the diagnostic blocks the transaction, including backups.
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left._tag).toBe("ConfigTranslateError");
    expect(result.left.message).toContain("unsupported");
  }
  expect(await Bun.file(join(cwd, ".lando.yml")).text()).toBe(original);
  expect(await readdir(cwd)).toEqual([".lando.yml"]);
});

test.each([
  [{ source: "missing.yml", kind: "landofile" }],
  ["missing.yml"],
  [{ source: "https://example.test/compose.yml", kind: "compose" }],
  [{ source: "git@example.test:compose.yml", kind: "compose" }],
])("ignores out-of-scope includes %j", async (entry) => {
  // Given: an include outside local compose validation.
  const cwd = await makeApp();
  // When: previewing it.
  const result = await Effect.runPromise(appConfigTranslate({ cwd, translators: makeTranslators([entry]) }));
  // Then: no filesystem diagnostic is emitted.
  expect(result.mode).toBe("preview");
  if (result.mode !== "preview") throw new Error("Expected preview");
  expect(result.diagnostics).toEqual([]);
});
