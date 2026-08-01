import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkSpecReference } from "../../../scripts/check-spec-reference.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-spec-reference-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

/** Distinct offending files; one file can offend on several lines. */
const offenderPaths = (root: string, offenders: ReadonlyArray<{ file: string }>): ReadonlyArray<string> =>
  [...new Set(offenders.map((offender) => relative(root, offender.file)))].sort();

describe("spec reference boundary gate", () => {
  test("passes on a tree that states its details without citing the specification", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "AGENTS.md", "- Core failures are tagged errors with remediation.\n");
      await write(root, "README.md", "Lando v4 is a Bun monorepo.\n");
      await write(root, "core/src/a.ts", "// Proxy and routing schemas.\nexport const a = 1;\n");

      expect(await checkSpecReference({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports section-sign citations in top-level guidance files", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "AGENTS.md", "- Side effects belong behind services (spec \u00a71.2).\n");
      await write(root, "README.md", "See \u00a717.9 for acceptance criteria.\n");

      const result = await checkSpecReference({ root });

      expect(result.ok).toBe(false);
      expect(offenderPaths(root, result.offenders)).toEqual(["AGENTS.md", "README.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports specification path references across every scanned file type", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "docs/a.md", "See [services](spec/06-services.md).\n");
      await write(root, "docs/b.mdx", "Described in `spec/07-landofile-and-config.md`.\n");
      await write(root, "sdk/c.json", '{ "justification": "spec/05-runtime-providers.md" }\n');
      await write(root, "d.yml", "note: spec/ROADMAP.md\n");

      const result = await checkSpecReference({ root });

      expect(result.ok).toBe(false);
      expect(offenderPaths(root, result.offenders)).toEqual([
        "d.yml",
        "docs/a.md",
        "docs/b.mdx",
        "sdk/c.json",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports SPEC comment banners and constructed specification paths in source", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "sdk/src/proxy.ts", "// SPEC: proxy and routing\nexport const p = 1;\n");
      await write(
        root,
        "scripts/evasive.ts",
        'const root = ["s", "pec"].join("");\nexport const dir = `${root}/alpha-3`;\n',
      );
      await write(
        root,
        "core/test/reads.ts",
        'import { resolve } from "node:path";\nresolve(root, "spec");\n',
      );

      const result = await checkSpecReference({ root });

      expect(result.ok).toBe(false);
      expect(offenderPaths(root, result.offenders)).toEqual([
        "core/test/reads.ts",
        "scripts/evasive.ts",
        "sdk/src/proxy.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not report unrelated identifiers, upstream org names, or the word specification", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "a.ts",
        "const imageSpec = 1;\nexport type SubsystemSpec = { readonly id: string };\n",
      );
      await write(root, "b.yml", "image: compose-spec/compose-go\nspec: prettier\n");
      await write(root, "c.md", "A scalar mount specification canonicalizes to a list.\n");
      await write(root, "d.ts", 'const spec = { command: "podman" };\nexport const argv = [spec.command];\n');

      expect(await checkSpecReference({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never reports files inside the specification tree itself", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "spec/06-services.md", "See \u00a76.11 and spec/07-landofile-and-config.md.\n");
      await write(root, "spec/alpha-3/prd.json", '{ "notes": "spec/ROADMAP.md \u00a713.1" }\n');

      expect(await checkSpecReference({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
