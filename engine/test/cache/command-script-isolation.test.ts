import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { compileInspectedAppCommands, scriptLoadError } from "../../src/cache/command-compiler.ts";
import {
  COMMAND_INDEX_SCHEMA_VERSION,
  decodeAppCommandIndex,
  encodeAppCommandIndex,
} from "../../src/cache/command-index.ts";
import { commandScriptsFresh, fingerprintsFromInspection } from "../../src/cache/command-script-freshness.ts";

const withScripts = async (run: (root: string, scripts: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-script-isolation-"));
  const scripts = join(root, ".lando/scripts");
  try {
    await mkdir(scripts, { recursive: true });
    await run(root, scripts);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const inspect = (root: string) => Effect.runPromise(inspectBunShellScripts({ appRoot: root }));
const redact = createRedactor("secrets").redactString;

test.each([
  { content: "", tag: "BunShellScriptEmptyError" },
  { content: "echo broken", tag: "BunShellScriptFrontMatterError" },
  { content: "# ---\n# flags: [unclosed\n# ---\necho broken", tag: "BunShellScriptFrontMatterError" },
  { content: "# ---\n# wrapper: true\n# ---\necho broken", tag: "BunShellScriptFrontMatterError" },
  { content: "# ---\n# engine: custom\n# ---\necho broken", tag: "NotImplementedError" },
  { content: "# ---\n# service: web\n# ---\necho broken", tag: "NotImplementedError" },
  {
    content: "# ---\n# flags:\n#   name:\n#     required: true\n#     default: bad\n# ---\necho broken",
    tag: "BunShellScriptFrontMatterError",
  },
])("indexes a $tag content failure without blocking a healthy command (#2210)", async ({ content, tag }) => {
  await withScripts(async (root, scripts) => {
    await writeFile(join(scripts, "bad.bun.sh"), content);
    await writeFile(join(scripts, "good.bun.sh"), "# ---\n# ---\necho good\n");
    const inspection = await inspect(root);
    const entries = compileInspectedAppCommands({ landofile: {}, inspection, redact, sourcePath: root });
    expect(entries.map((entry) => entry.id)).toEqual(["app:bad", "app:good"]);
    expect(entries[0]).toMatchObject({
      _tag: "Unavailable",
      sourceKind: "bun-script",
      diagnostic: { _tag: tag },
    });
    expect(entries[0]).not.toHaveProperty("input");
    expect(entries[1]?.input).toBeDefined();
    expect(await commandScriptsFresh(root, fingerprintsFromInspection(inspection), true)).toBe(true);
  });
});

test("carries located, reason-tagged script findings into the cached diagnostic", async () => {
  await withScripts(async (root, scripts) => {
    // Given one block with three independent env refusals
    await writeFile(
      join(scripts, "bad.bun.sh"),
      [
        "# ---",
        "# env:",
        '#   A: "{{ env.HOME }}"',
        '#   B: "{{ services[vars.name].port }}"',
        '#   C: "{{ services.web.port }}"',
        "# ---",
        "echo x",
        "",
      ].join("\n"),
    );
    // When the app command index compiles it
    const inspection = await inspect(root);
    const entries = compileInspectedAppCommands({ landofile: {}, inspection, redact, sourcePath: root });
    // Then the unavailable entry names the file and each front-matter key with a stable reason
    const entry = entries.find((candidate) => candidate.id === "app:bad");
    expect(entry).toMatchObject({
      _tag: "Unavailable",
      diagnostic: {
        _tag: "BunShellScriptFrontMatterError",
        omittedIssueCount: 0,
        issues: [
          { reason: "other-scope", path: ["env", "A"] },
          { reason: "computed-service", path: ["env", "B"] },
          { reason: "non-route-fact", path: ["env", "C"] },
        ],
      },
    });
    if (entry?._tag !== "Unavailable") throw new Error("expected an unavailable entry");
    for (const issue of entry.diagnostic.issues ?? [])
      expect(issue.source).toEqual({ layer: "script", file: join(scripts, "bad.bun.sh"), path: issue.path });
  });
});

test("merges every problem sharing a script id into one cached diagnostic", async () => {
  await withScripts(async (root, scripts) => {
    // Given a block with an unsupported key and an independently refused env value
    await writeFile(
      join(scripts, "bad.bun.sh"),
      ["# ---", "# engine: custom", "# env:", '#   SITE: "{{ env.HOME }}"', "# ---", "echo x", ""].join("\n"),
    );
    // When the index compiles it
    const inspection = await inspect(root);
    const entries = compileInspectedAppCommands({ landofile: {}, inspection, redact, sourcePath: root });
    const entry = entries.find((candidate) => candidate.id === "app:bad");
    // Then the one diagnostic carries both findings, deduped by path
    expect(entry).toMatchObject({
      _tag: "Unavailable",
      diagnostic: {
        omittedIssueCount: 0,
        issues: [
          { reason: "unsupported-key", path: ["engine"] },
          { reason: "other-scope", path: ["env", "SITE"] },
        ],
      },
    });
    if (entry?._tag !== "Unavailable") throw new Error("expected an unavailable entry");
    expect(entry.diagnostic.issues?.map((issue) => issue.path)).toEqual([["engine"], ["env", "SITE"]]);
  });
});

test("keeps a diagnostic with very long front-matter keys decodable", async () => {
  await withScripts(async (root, scripts) => {
    // Given an env key long enough that its raw path and message would overflow the diagnostic bound
    const key = `SITE_${"x".repeat(40_000)}`;
    await writeFile(
      join(scripts, "long.bun.sh"),
      ["# ---", "# env:", `#   ${key}: "{{ env.HOME }}"`, "# ---", "echo x", ""].join("\n"),
    );
    // When the index compiles and encodes it
    const inspection = await inspect(root);
    const entries = compileInspectedAppCommands({ landofile: {}, inspection, redact, sourcePath: root });
    const bytes = encodeAppCommandIndex({
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      appName: "fixture",
      sourceFile: join(root, ".lando.yml"),
      sourceProjectFiles: [],
      sourceEnvironment: { _tag: "Names", names: [], hash: "0".repeat(64) },
      sourceMtimeMs: 0,
      sourceSize: 0,
      generatedAtMs: 0,
      entries,
    });
    // Then the decoder accepts it and the diagnostic stays under its own limit
    const decoded = decodeAppCommandIndex(bytes);
    expect(decoded).not.toBeNull();
    const diagnostic = decoded?.entries.find((entry) => entry.id === "app:long");
    if (diagnostic?._tag !== "Unavailable") throw new Error("expected an unavailable entry");
    expect(Buffer.byteLength(JSON.stringify(diagnostic.diagnostic))).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.stringify(diagnostic.diagnostic)).not.toContain(key);
  });
});

test("drops issues into omittedIssueCount when a script diagnostic would overflow", async () => {
  await withScripts(async (root, scripts) => {
    // Given eight refused env values in a deep script path, whose bounded issues together exceed
    // the diagnostic limit once each source file is bounded to its own maximum
    const keys = Array.from({ length: 8 }, (_, index) => `SITE_${index}_${"x".repeat(1500)}`);
    const deep = join(scripts, ...Array.from({ length: 5 }, (_, index) => `${index}${"d".repeat(140)}`));
    await mkdir(deep, { recursive: true });
    await writeFile(
      join(deep, "many.bun.sh"),
      ["# ---", "# env:", ...keys.map((key) => `#   ${key}: "{{ env.HOME }}"`), "# ---", "echo x", ""].join(
        "\n",
      ),
    );
    // When
    const inspection = await inspect(root);
    const entries = compileInspectedAppCommands({ landofile: {}, inspection, redact, sourcePath: root });
    const bytes = encodeAppCommandIndex({
      schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
      landoVersion: "0.0.0",
      appName: "fixture",
      sourceFile: join(root, ".lando.yml"),
      sourceProjectFiles: [],
      sourceEnvironment: { _tag: "Names", names: [], hash: "0".repeat(64) },
      sourceMtimeMs: 0,
      sourceSize: 0,
      generatedAtMs: 0,
      entries,
    });
    // Then the decoder accepts it, some issues moved to the omission count, and it fits
    const decoded = decodeAppCommandIndex(bytes);
    expect(decoded).not.toBeNull();
    const [diagnostic] = (decoded?.entries ?? []).filter((entry) => entry._tag === "Unavailable");
    if (diagnostic?._tag !== "Unavailable") throw new Error("expected an unavailable entry");
    expect(diagnostic.diagnostic.omittedIssueCount).toBeGreaterThan(0);
    expect(diagnostic.diagnostic.issues?.length ?? 0).toBeLessThan(8);
    expect(Buffer.byteLength(JSON.stringify(diagnostic.diagnostic))).toBeLessThanOrEqual(16 * 1024);
  });
});

test("groups every collision before parsing, and lets a Landofile task win (#2210)", async () => {
  await withScripts(async (root, scripts) => {
    for (const name of ["FOO", "Foo", "foo"])
      await writeFile(join(scripts, `${name}.bun.sh`), name === "foo" ? "broken" : "# ---\n# ---\necho ok");
    const inspection = await inspect(root);
    const entries = compileInspectedAppCommands({ landofile: {}, inspection, redact, sourcePath: root });
    expect(inspection.scripts).toEqual([]);
    expect(entries).toHaveLength(1);
    for (const name of ["FOO", "Foo", "foo"])
      expect(entries[0]?.diagnostic?.message).toContain(`${name}.bun.sh`);
    const overridden = compileInspectedAppCommands({
      sourcePath: root,
      landofile: { tooling: { foo: { cmd: "echo authored", service: ":host" } } },
      inspection,
      redact,
    });
    expect(overridden).toHaveLength(1);
    expect(overridden[0]?.input).toBeDefined();
    expect(overridden[0]).not.toHaveProperty("diagnostic");
  });
});

test("does not register a filename with no usable canonical id", async () => {
  await withScripts(async (root, scripts) => {
    await writeFile(join(scripts, "$.bun.sh"), "# ---\n# ---\necho unusable");
    const inspection = await inspect(root);
    expect(inspection.problems).toHaveLength(1);
    expect(compileInspectedAppCommands({ landofile: {}, inspection, redact, sourcePath: root })).toEqual([]);
  });
});

test("redacts diagnostics before bounding UTF-8 messages and remediation to 1 KiB", async () => {
  await withScripts(async (root, scripts) => {
    await writeFile(join(scripts, "bad.bun.sh"), "broken");
    const problem = (await inspect(root)).problems[0];
    if (problem === undefined) throw new Error("Missing broken-script problem");
    const protectedText = `secret-canary ${"\u754c".repeat(2000)}`;
    const diagnostic = scriptLoadError(
      {
        ...problem,
        error: Object.assign(problem.error, { message: protectedText, remediation: protectedText }),
      },
      createRedactor("secrets", { values: ["secret-canary"] }).redactString,
    );
    expect(diagnostic.message).toStartWith("[redacted]");
    expect(diagnostic.remediation).toContain("[redacted]");
    expect(diagnostic.remediation).toContain("lando app:config:lint");
    expect(Buffer.byteLength(diagnostic.message)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(diagnostic.remediation ?? "")).toBeLessThanOrEqual(1024);
    expect(diagnostic.message).not.toContain("\ufffd");
  });
});

test("detects added, edited, fixed and newly colliding scripts deterministically", async () => {
  await withScripts(async (root, scripts) => {
    const empty = fingerprintsFromInspection(await inspect(root));
    await writeFile(join(scripts, "bad.bun.sh"), "broken");
    expect(await commandScriptsFresh(root, empty, true)).toBe(false);
    const broken = fingerprintsFromInspection(await inspect(root));
    await writeFile(join(scripts, "bad.bun.sh"), "edited broken");
    expect(await commandScriptsFresh(root, broken)).toBe(false);
    const edited = fingerprintsFromInspection(await inspect(root));
    await writeFile(join(scripts, "bad.bun.sh"), "# ---\n# ---\necho fixed");
    expect(await commandScriptsFresh(root, edited)).toBe(false);
    const fixed = fingerprintsFromInspection(await inspect(root));
    await writeFile(join(scripts, "BAD.bun.sh"), "broken collision");
    expect(await commandScriptsFresh(root, fixed, true)).toBe(false);
  });
});
