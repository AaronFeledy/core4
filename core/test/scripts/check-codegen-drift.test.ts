import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CATALOG_OUTPUT_PATHS,
  GitStatusError,
  checkCodegenDrift,
} from "../../../scripts/check-codegen-drift.ts";

const EXPECTED_CATALOG_PATHS = [
  ".github/workflows",
  "core/test/fixtures/compose/manifest.json",
  "docs/reference/commands.mdx",
  "docs/reference/compose-key-matrix.mdx",
  "images/php",
  "plugins/file-sync-mutagen/mutagen-versions.json",
  "recipes/*/.scaffold/*",
  "sdk/test/fixtures/bundled-plugin-manifests.json",
] as const;

const GITIGNORED_DERIVED_PATHS = [
  "core/src/cli/generated",
  "core/src/cli/oclif/generated",
  "engine/src/data-mover/generated/provider-images.ts",
  "core/src/plugins/generated",
  "core/src/recipes/bundled.ts",
  "core/src/runtime/generated/layers",
  "dist/command-schemas",
  "dist/schemas",
  "docs/reference/schemas",
  "scripts/generated/opentui-native",
] as const;

const TRACKED_CATALOG_SENTINELS = [
  ".github/workflows/ci.yml",
  "core/test/fixtures/compose/manifest.json",
  "docs/reference/commands.mdx",
  "images/php/8.4/Dockerfile",
  "plugins/file-sync-mutagen/mutagen-versions.json",
  "recipes/drupal/.scaffold/default.md",
  "sdk/test/fixtures/bundled-plugin-manifests.json",
] as const;

interface Fixture {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const repoRoot = resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
const text = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

const readPackageJsonScripts = async (root: string): Promise<Readonly<Record<string, string>>> => {
  const parsed: unknown = await Bun.file(resolve(root, "package.json")).json();
  if (parsed === null || typeof parsed !== "object" || !("scripts" in parsed)) {
    throw new TypeError("package.json is missing a scripts object");
  }
  const { scripts } = parsed;
  if (scripts === null || typeof scripts !== "object") {
    throw new TypeError("package.json scripts is not an object");
  }
  const entries = Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
};

const makeIsolatedGitEnv = async (root: string): Promise<Readonly<Record<string, string | undefined>>> => {
  const emptyConfigPath = join(root, "empty.gitconfig");
  await writeFile(emptyConfigPath, "", "utf8");
  return {
    ...Bun.env,
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_AUTHOR_NAME: "Lando Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Lando Test",
    GIT_CONFIG_GLOBAL: emptyConfigPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: emptyConfigPath,
    GIT_TERMINAL_PROMPT: "0",
    HOME: root,
  };
};

const write = async (root: string, path: string, content: string): Promise<void> => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
};

const runGit = async (
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  args: ReadonlyArray<string>,
): Promise<void> => {
  const process = Bun.spawn({ cmd: ["git", ...args], cwd: root, env, stderr: "pipe", stdout: "ignore" });
  const [exitCode, stderr] = await Promise.all([process.exited, text(process.stderr)]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
};

const makeRepository = async (): Promise<Fixture> => {
  const root = await mkdtemp(join(tmpdir(), "lando-codegen-drift-"));
  roots.push(root);
  const env = await makeIsolatedGitEnv(root);
  await runGit(root, env, ["init", "-b", "main"]);
  await write(root, ".gitignore", "ignored-output.json\n");
  await write(root, ".github/workflows/old.yml", "name: old\n");
  await write(root, "docs/reference/commands.mdx", "# Commands\n");
  await write(root, "README.md", "# Fixture\n");
  await write(root, "recipes/demo/.scaffold/default.md", "# Default scaffold\n");
  await runGit(root, env, ["add", "."]);
  await runGit(root, env, ["commit", "-m", "fixture"]);
  return { root, env };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("check:codegen-drift", () => {
  test("passes when the generated catalog is clean", async () => {
    // Given: a clean git repository containing a tracked catalog file.
    const { root, env } = await makeRepository();

    // When: catalog drift is checked.
    const result = await checkCodegenDrift({ env, root });

    // Then: no drift is reported.
    expect(result).toEqual({ dirtyPaths: [], ok: true });
  });

  test("fails when a tracked catalog file is modified", async () => {
    // Given: a tracked catalog file with a worktree modification.
    const { root, env } = await makeRepository();
    await write(root, "docs/reference/commands.mdx", "# Changed commands\n");

    // When: catalog drift is checked.
    const result = await checkCodegenDrift({ env, root });

    // Then: the tracked modification is reported.
    expect(result).toEqual({ dirtyPaths: ["docs/reference/commands.mdx"], ok: false });
  });

  test("fails when an untracked file appears in a catalog directory", async () => {
    // Given: an untracked generated file under a committed catalog path.
    const { root, env } = await makeRepository();
    await write(root, ".github/workflows/new.yml", "name: new\n");

    // When: catalog drift is checked.
    const result = await checkCodegenDrift({ env, root });

    // Then: the untracked catalog file is reported.
    expect(result).toEqual({ dirtyPaths: [".github/workflows/new.yml"], ok: false });
  });

  test("fails when a tracked catalog file is deleted", async () => {
    // Given: a tracked catalog file removed from the worktree.
    const { root, env } = await makeRepository();
    await rm(join(root, "docs/reference/commands.mdx"));

    // When: catalog drift is checked.
    const result = await checkCodegenDrift({ env, root });

    // Then: the deletion is reported.
    expect(result).toEqual({ dirtyPaths: ["docs/reference/commands.mdx"], ok: false });
  });

  test("fails for tracked and untracked recipe scaffold drift", async () => {
    // Given: a tracked scaffold modification and an untracked scaffold beside it.
    const { root, env } = await makeRepository();
    await write(root, "recipes/demo/.scaffold/default.md", "# Changed default scaffold\n");
    await write(root, "recipes/demo/.scaffold/extra.md", "# Extra scaffold\n");

    // When: catalog drift is checked.
    const result = await checkCodegenDrift({ env, root });

    // Then: both scaffold paths are reported.
    expect(result).toEqual({
      dirtyPaths: ["recipes/demo/.scaffold/default.md", "recipes/demo/.scaffold/extra.md"],
      ok: false,
    });
  });

  test("consumes both NUL path fields for a tracked rename", async () => {
    // Given: a tracked catalog file renamed within a catalog directory.
    const { root, env } = await makeRepository();
    await runGit(root, env, ["mv", ".github/workflows/old.yml", ".github/workflows/new.yml"]);

    // When: catalog drift is checked.
    const result = await checkCodegenDrift({ env, root });

    // Then: both rename paths are reported without treating the extra field as a status record.
    expect(result).toEqual({
      dirtyPaths: [".github/workflows/new.yml", ".github/workflows/old.yml"],
      ok: false,
    });
  });

  test("ignores unrelated worktree dirt", async () => {
    // Given: tracked and untracked changes outside the catalog path set.
    const { root, env } = await makeRepository();
    await write(root, "README.md", "# Changed fixture\n");
    await write(root, "scratch.txt", "untracked\n");

    // When: catalog drift is checked.
    const result = await checkCodegenDrift({ env, root });

    // Then: unrelated dirt does not fail the catalog gate.
    expect(result).toEqual({ dirtyPaths: [], ok: true });
  });

  test("ignores gitignored files in a catalog directory", async () => {
    // Given: a gitignored generated file under a catalog path.
    const { root, env } = await makeRepository();
    await write(root, ".github/workflows/ignored-output.json", "{}\n");

    // When: catalog drift is checked.
    const result = await checkCodegenDrift({ env, root });

    // Then: ignored output does not fail the catalog gate.
    expect(result).toEqual({ dirtyPaths: [], ok: true });
  });

  test("keeps the catalog path set aligned with the documented CI union", () => {
    // Given: the existing CI-generated artifact path union.
    // When: the checker path set is inspected.
    // Then: all committed output paths and no others are present in documented order.
    expect(CATALOG_OUTPUT_PATHS).toEqual(EXPECTED_CATALOG_PATHS);
  });

  test("excludes gitignored derived outputs from the git-status drift check", () => {
    // Given: derived outputs whose generator and consumer validation own correctness.
    // When: the checker path set is inspected.
    // Then: none of those trees appear (prevents reintroduction into git-status drift).
    for (const path of GITIGNORED_DERIVED_PATHS) {
      expect(CATALOG_OUTPUT_PATHS).not.toContain(path);
    }
  });

  test("covers representative tracked output from every catalog generator path", async () => {
    // Given: fixed tracked sentinels selected independently from generator outputs.
    const process = Bun.spawn({
      cmd: ["git", "ls-files", "--", ...CATALOG_OUTPUT_PATHS],
      cwd: repoRoot,
      stderr: "pipe",
      stdout: "pipe",
    });

    // When: tracked files covered by the production catalog pathspecs are listed.
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      text(process.stdout),
      text(process.stderr),
    ]);
    if (exitCode !== 0) throw new Error(`git ls-files failed: ${stderr.trim()}`);
    const matchedPaths = stdout.split("\n").filter((path) => path.length > 0);

    // Then: every independent sentinel is matched by the production pathspecs.
    expect(matchedPaths).toEqual(expect.arrayContaining([...TRACKED_CATALOG_SENTINELS]));
  });

  test("rejects a directory that is not a git repository", async () => {
    // Given: an isolated, non-git temporary directory.
    const root = await mkdtemp(join(tmpdir(), "lando-codegen-drift-non-git-"));
    roots.push(root);
    const env = await makeIsolatedGitEnv(root);

    // When: catalog drift is checked.
    const result = checkCodegenDrift({ env, root });

    // Then: the git failure is propagated as a checker failure.
    await expect(result).rejects.toBeInstanceOf(GitStatusError);
  });
});

describe("check:codegen-drift package wiring", () => {
  test("keeps the standalone check:codegen-drift script wired to the checker entrypoint", async () => {
    // Given: the monorepo package.json scripts table.
    const scripts = await readPackageJsonScripts(repoRoot);

    // When / Then: the standalone script invokes the checker entrypoint directly.
    expect(scripts["check:codegen-drift"]).toBe("bun run scripts/check-codegen-drift.ts");
  });

  test("wires check:codegen-drift into codegen:check after codegen and before check:deprecations", async () => {
    // Given: the monorepo package.json scripts table.
    const scripts = await readPackageJsonScripts(repoRoot);
    const codegenCheck = scripts["codegen:check"];
    if (codegenCheck === undefined) throw new TypeError("package.json is missing codegen:check");

    // When: the codegen:check pipeline is inspected.
    // Then: the exact pipeline runs codegen, then the drift gate, then deprecations, then typecheck.
    expect(codegenCheck).toBe(
      "bun run codegen && bun run check:codegen-drift && bun run check:deprecations && bun run typecheck",
    );

    // Then: the ordering holds independent of the exact command wording.
    const codegenIndex = codegenCheck.indexOf("bun run codegen");
    const driftIndex = codegenCheck.indexOf("bun run check:codegen-drift");
    const deprecationsIndex = codegenCheck.indexOf("bun run check:deprecations");
    expect(codegenIndex).toBeGreaterThanOrEqual(0);
    expect(driftIndex).toBeGreaterThan(codegenIndex);
    expect(deprecationsIndex).toBeGreaterThan(driftIndex);
  });
});
