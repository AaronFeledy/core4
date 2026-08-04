import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  CHECK_MODULE_PATH,
  FixtureCommandError,
  callExport,
  captureFailure,
  cleanupRepositories,
  commit,
  expectInputFailure,
  field,
  git,
  installGitShim,
  makeRepository,
  regenerate,
  runFixtureCommand,
  unavailableFamilies,
  worktreeCount,
  writeFixtureFile,
} from "./fixtures/schema-baseline-fixture.ts";

afterEach(async () => {
  await cleanupRepositories();
});

const artifactsFrom = (result: unknown): Map<unknown, unknown> => {
  const artifacts = field(result, "artifacts");
  expect(artifacts).toBeInstanceOf(Map);
  if (!(artifacts instanceof Map)) throw new FixtureCommandError("read artifacts", "expected Map");
  return artifacts;
};

describe("isolated schema compatibility baseline regeneration", () => {
  test("regenerates both artifact families with the base generator and cleans its worktree", async () => {
    // Given: alpha at the base commit and a beta generator in the head checkout.
    const fixture = await makeRepository();

    // When: the base artifacts are regenerated.
    const result = await regenerate({ baseRef: fixture.baseRef, env: fixture.env, repoRoot: fixture.root });

    // Then: both artifacts came from alpha and the temporary worktree was removed.
    const artifacts = artifactsFrom(result);
    expect(field(field(artifacts.get("schema:Fixture"), "schema"), "const")).toBe("alpha");
    expect(field(field(artifacts.get("command:fixture"), "schema"), "const")).toBe("alpha");
    expect(unavailableFamilies(result)).toEqual([]);
    expect(await worktreeCount(fixture)).toBe(1);
  }, 30_000);

  test("fails closed when base dependency installation fails and cleans its worktree", async () => {
    // Given: a zero-dependency base whose install lifecycle exits nonzero.
    const fixture = await makeRepository();
    await writeFixtureFile(
      fixture.root,
      "package.json",
      '{"name":"schema-fixture","private":true,"scripts":{"codegen:schema-snapshot":"bun run scripts/build-schema-snapshot.ts","preinstall":"exit 19"}}\n',
    );
    await rm(join(fixture.root, "bun.lock"));
    await runFixtureCommand(fixture.root, fixture.env, [
      "bun",
      "install",
      "--lockfile-only",
      "--ignore-scripts",
    ]);
    const baseRef = await commit(fixture, "failing install");

    // When: regeneration attempts to install the base checkout.
    const failure = await captureFailure(() =>
      regenerate({ baseRef, env: fixture.env, repoRoot: fixture.root }),
    );

    // Then: a typed, base-specific failure is returned and no worktree leaks.
    await expectInputFailure(failure, baseRef);
    expect(await worktreeCount(fixture)).toBe(1);
  }, 30_000);

  test("fails closed when the base generator fails and cleans its worktree", async () => {
    // Given: a valid base generator configured to exit nonzero.
    const fixture = await makeRepository();
    const env = { ...fixture.env, FAIL_GENERATOR: "1" };

    // When: regeneration executes the base generator.
    const failure = await captureFailure(() =>
      regenerate({ baseRef: fixture.baseRef, env, repoRoot: fixture.root }),
    );

    // Then: a typed, base-specific failure is returned and no worktree leaks.
    await expectInputFailure(failure, fixture.baseRef);
    expect(await worktreeCount(fixture)).toBe(1);
  }, 30_000);

  test("skips both families exactly when history predates the generator without a worktree", async () => {
    // Given: a historical base with no schema snapshot generator and one current surface per family.
    const fixture = await makeRepository();
    const current = new Map([
      ["schema:Fixture", { surface: "schema:Fixture", polarity: "strict" as const, schema: {} }],
      ["command:fixture", { surface: "command:fixture", polarity: "output" as const, schema: {} }],
    ]);
    const countBefore = await worktreeCount(fixture);

    // When: the historical base is regenerated.
    const result = await regenerate({
      baseRef: fixture.historicalRef,
      env: fixture.env,
      repoRoot: fixture.root,
    });

    // Then: sdk and command skips each count one surface, without creating a worktree.
    const artifacts = artifactsFrom(result);
    expect(artifacts.size).toBe(0);
    const families = unavailableFamilies(result);
    expect(families).toEqual(["sdk", "command"]);
    const notices = await callExport(CHECK_MODULE_PATH, "skippedFamilyNotices", [
      current,
      fixture.historicalRef,
      families,
    ]);
    expect(notices).toEqual([
      {
        family: "sdk",
        count: 1,
        generatorPath: "scripts/build-schema-snapshot.ts",
        baseRef: fixture.historicalRef,
      },
      {
        family: "command",
        count: 1,
        generatorPath: "scripts/build-schema-snapshot.ts",
        baseRef: fixture.historicalRef,
      },
    ]);
    expect(await worktreeCount(fixture)).toBe(countBefore);
  }, 30_000);

  test("fails closed when the historical generator probe fails operationally", async () => {
    // Given: a valid base ref whose git tree probe exits nonzero.
    const fixture = await makeRepository();
    const countBefore = await worktreeCount(fixture);
    const shim = await installGitShim(fixture, { mode: "fail-ls-tree" });

    // When: regeneration probes for the historical generator.
    const failure = await captureFailure(() =>
      regenerate({ baseRef: fixture.baseRef, env: shim.env, repoRoot: fixture.root }),
    );

    // Then: the operational failure is typed and does not masquerade as historical absence.
    await expectInputFailure(failure, fixture.baseRef);
    expect(await worktreeCount(fixture)).toBe(countBefore);
  }, 30_000);

  test("uses the resolved commit SHA after a mutable base ref moves", async () => {
    // Given: a branch at alpha that moves to beta immediately after resolution.
    const fixture = await makeRepository();
    const mutableRef = "refs/heads/moving-base";
    const mutationTarget = await git(fixture, "rev-parse", "HEAD");
    await git(fixture, "branch", "moving-base", fixture.baseRef);
    const shim = await installGitShim(fixture, {
      mode: "move-ref-after-resolution",
      mutableRef,
      mutationTarget,
    });

    // When: regeneration resolves and uses the moving ref.
    const result = await regenerate({ baseRef: mutableRef, env: shim.env, repoRoot: fixture.root });

    // Then: the alpha commit supplies both the probe and detached worktree inputs.
    const artifacts = artifactsFrom(result);
    expect(field(field(artifacts.get("schema:Fixture"), "schema"), "const")).toBe("alpha");
    const commands = (await Bun.file(shim.logPath).text()).trim().split("\n");
    expect(commands).toContain(
      `ls-tree -z --full-tree --name-only ${fixture.baseRef} -- scripts/build-schema-snapshot.ts`,
    );
    expect(
      commands.some(
        (command) => command.startsWith("worktree add --detach ") && command.endsWith(` ${fixture.baseRef}`),
      ),
    ).toBe(true);
  }, 30_000);

  test("rejects an unresolvable base ref without creating a worktree", async () => {
    // Given: an isolated repository and a base ref that does not resolve.
    const fixture = await makeRepository();
    const baseRef = "refs/heads/missing-base";
    const countBefore = await worktreeCount(fixture);

    // When: regeneration resolves the missing base.
    const failure = await captureFailure(() =>
      regenerate({ baseRef, env: fixture.env, repoRoot: fixture.root }),
    );

    // Then: a typed, base-specific failure is returned without creating a worktree.
    await expectInputFailure(failure, baseRef);
    expect(await worktreeCount(fixture)).toBe(countBefore);
  }, 30_000);
});
