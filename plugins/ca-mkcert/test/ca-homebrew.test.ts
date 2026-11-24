import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessResult } from "@lando/sdk/services";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect } from "effect";

import {
  type CaHarness,
  MKCERT_BIN,
  makeCa,
  makeCaHarness,
  makeFakeMkcertRunner,
  okResult,
  patchHostArtifact,
} from "./_fixtures.ts";

const { rootA, rootB } = TEST_CERTIFICATES;

interface Homebrew {
  readonly prefix: string;
  readonly bundle: string;
  readonly brew: string;
}

type Runner = ReturnType<typeof makeFakeMkcertRunner>;

const withHomebrew = async (
  options: {
    /** Bundle contents before setup; no bundle file when undefined. */
    readonly bundle?: string;
    /** Whether the `ca-certificates` formula is installed. */
    readonly formula?: boolean;
    /** Answers `brew postinstall ca-certificates` given the prefix. */
    readonly postinstall?: (homebrew: Homebrew) => Promise<ProcessResult>;
    readonly env?: (homebrew: Homebrew) => Readonly<Record<string, string>>;
    readonly trusted?: boolean;
  },
  body: (input: {
    readonly homebrew: Homebrew;
    readonly runner: Runner;
    readonly ca: ReturnType<typeof makeCa>["ca"];
  }) => Promise<void>,
) => {
  const harness: CaHarness = await makeCaHarness();
  const restore = patchHostArtifact(MKCERT_BIN);
  try {
    const prefix = join(harness.root, "homebrew");
    const homebrew = {
      prefix,
      bundle: join(prefix, "etc", "ca-certificates", "cert.pem"),
      brew: join(prefix, "bin", "brew"),
    };
    await mkdir(join(prefix, "etc", "ca-certificates"), { recursive: true });
    if (options.formula !== false) await mkdir(join(prefix, "opt", "ca-certificates"), { recursive: true });
    if (options.bundle !== undefined) await writeFile(homebrew.bundle, options.bundle);
    await mkdir(harness.caRoot, { recursive: true });
    await writeFile(join(harness.caRoot, "rootCA.pem"), rootA);
    const postinstall = options.postinstall;
    const runner = makeFakeMkcertRunner({
      caRoot: harness.caRoot,
      ...(postinstall === undefined ? {} : { brewPostinstall: () => postinstall(homebrew) }),
    });
    const { ca } = makeCa(harness, runner, {
      env: options.env?.(homebrew) ?? { HOMEBREW_PREFIX: prefix, PATH: "" },
      hostTrustsPem: () => options.trusted ?? true,
    });
    await body({ homebrew, runner, ca });
  } finally {
    restore();
    await harness.cleanup();
  }
};

const brewCalls = (runner: Runner) => runner.calls().filter((call) => call.args[0] === "postinstall");

const rebuildWith =
  (contents: string) =>
  async ({ bundle }: Homebrew): Promise<ProcessResult> => {
    await writeFile(bundle, contents);
    return okResult();
  };

describe("mkcert CertificateAuthority and Homebrew's CA bundle", () => {
  test("setup rebuilds a bundle that lacks the root, without elevation", async () => {
    await withHomebrew({ bundle: rootB, postinstall: rebuildWith(`${rootB}\n${rootA}`) }, async (input) => {
      // When
      const result = await Effect.runPromise(input.ca.setup({ force: false }));
      // Then
      expect(result).toEqual({
        refreshedBundles: [{ owner: "Homebrew", path: input.homebrew.bundle }],
        warnings: [],
      });
      expect(brewCalls(input.runner)).toEqual([
        {
          cmd: input.homebrew.brew,
          args: ["postinstall", "ca-certificates"],
          env: { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" },
        },
      ]);
    });
  });

  test("setup finds Homebrew through the brew on PATH without resolving its link", async () => {
    await withHomebrew(
      {
        bundle: rootB,
        postinstall: rebuildWith(rootA),
        env: ({ prefix }) => ({ PATH: join(prefix, "bin") }),
      },
      async (input) => {
        // Given: like Linuxbrew, bin/brew links into a repository outside the prefix
        const repository = join(input.homebrew.prefix, "..", "brew-repository", "bin");
        await mkdir(repository, { recursive: true });
        await writeFile(join(repository, "brew"), "#!/bin/sh\n");
        await chmod(join(repository, "brew"), 0o755);
        await mkdir(join(input.homebrew.prefix, "bin"), { recursive: true });
        await symlink(join(repository, "brew"), input.homebrew.brew);
        // When
        const result = await Effect.runPromise(input.ca.setup({ force: false }));
        // Then
        expect(result.refreshedBundles).toEqual([{ owner: "Homebrew", path: input.homebrew.bundle }]);
        expect(brewCalls(input.runner).map(({ cmd }) => cmd)).toEqual([input.homebrew.brew]);
      },
    );
  });

  test.each([
    {
      name: "the bundle already holds the root",
      bundle: `${rootB}\n${rootA}`,
      formula: true,
      env: undefined,
    },
    { name: "the ca-certificates formula is not installed", bundle: rootB, formula: false, env: undefined },
    { name: "Homebrew is not installed", bundle: rootB, formula: true, env: () => ({ PATH: "" }) },
  ])("setup runs no brew when $name", async ({ bundle, formula, env }) => {
    await withHomebrew({ bundle, formula, ...(env === undefined ? {} : { env }) }, async (input) => {
      const result = await Effect.runPromise(input.ca.setup({ force: false }));
      expect(result).toEqual({ refreshedBundles: [], warnings: [] });
      expect(brewCalls(input.runner)).toEqual([]);
    });
  });

  test("setup with skipTrustInstall leaves a stale bundle alone", async () => {
    await withHomebrew({ bundle: rootB, postinstall: rebuildWith(rootA) }, async (input) => {
      const result = await Effect.runPromise(input.ca.setup({ force: false, skipTrustInstall: true }));
      expect(result).toEqual({ refreshedBundles: [], warnings: [] });
      expect(brewCalls(input.runner)).toEqual([]);
    });
  });

  test.each([
    {
      name: "brew fails",
      postinstall: async (): Promise<ProcessResult> => ({ exitCode: 1, stdout: "", stderr: "Error: no" }),
    },
    { name: "the rebuilt bundle still lacks the root", postinstall: rebuildWith(rootB) },
  ])("setup succeeds with a CA_BUNDLE_STALE warning when $name", async ({ postinstall }) => {
    await withHomebrew({ bundle: rootB, postinstall }, async (input) => {
      const result = await Effect.runPromise(input.ca.setup({ force: false }));
      expect(result.refreshedBundles).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({
        code: "CA_BUNDLE_STALE",
        context: { bundle: input.homebrew.bundle, owner: "Homebrew" },
      });
      expect(result.warnings[0]?.remediation).toEqual(expect.any(String));
    });
  });

  test("a failed brew run reports the error Homebrew printed on stdout, not its rerun hint", async () => {
    // Output of a real `brew postinstall ca-certificates` whose bundle directory is read-only.
    const stdout = [
      "==> Postinstalling ca-certificates",
      "mktemp: failed to create directory via template '/prefix/etc/ca-certificates/.ca-certificates.XXXXXX': Permission denied",
      "You can try again using:",
      "  brew postinstall ca-certificates",
    ].join("\n");
    const postinstall = async (): Promise<ProcessResult> => ({
      exitCode: 1,
      stdout,
      stderr: "Warning: The post-install step did not complete successfully\n",
    });
    await withHomebrew({ bundle: rootB, postinstall }, async (input) => {
      const [warning] = (await Effect.runPromise(input.ca.setup({ force: false }))).warnings;
      expect(warning?.message).toContain(
        "Permission denied; Warning: The post-install step did not complete successfully",
      );
      expect(warning?.message).not.toContain("try again");
    });
  });

  test.each([
    { name: "a bundle without the root", bundle: rootB },
    { name: "a missing bundle while the formula is installed", bundle: undefined },
  ])("root reports $name as stale when the host trusts the root", async ({ bundle }) => {
    await withHomebrew(bundle === undefined ? {} : { bundle }, async (input) => {
      await Effect.runPromise(input.ca.setup({ force: false, skipTrustInstall: true }));
      expect(await Effect.runPromise(input.ca.root)).toEqual({
        certificate: rootA,
        trusted: true,
        staleBundles: [{ owner: "Homebrew", path: input.homebrew.bundle }],
      });
      expect(brewCalls(input.runner)).toEqual([]);
    });
  });

  test.each([
    { name: "the host does not trust the root", bundle: rootB, trusted: false },
    { name: "the bundle holds the root", bundle: rootA, trusted: true },
  ])("root reports no stale bundles when $name", async ({ bundle, trusted }) => {
    await withHomebrew({ bundle, trusted }, async (input) => {
      await Effect.runPromise(input.ca.setup({ force: false, skipTrustInstall: true }));
      expect(await Effect.runPromise(input.ca.root)).toEqual({ certificate: rootA, trusted });
    });
  });
});
