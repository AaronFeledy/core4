import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { compileInspectedAppCommands, scriptLoadError } from "../../src/cache/command-compiler.ts";
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
