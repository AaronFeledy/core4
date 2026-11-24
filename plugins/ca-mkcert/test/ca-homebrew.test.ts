import { describe, expect, test } from "bun:test";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProcessExecError } from "@lando/sdk/errors";
import type { ProcessResult } from "@lando/sdk/services";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect } from "effect";

import {
  type CaHarness,
  MKCERT_BIN,
  makeCa,
  makeCaHarness,
  makeFakeMkcertRunner,
  makeFakePrivilege,
  okResult,
  patchHostArtifact,
} from "./_fixtures.ts";

const { rootA, rootB } = TEST_CERTIFICATES;

const INSTALL = "Run `lando setup` without `--skip-install-ca`.";
const LACKS_ROOT = "The bundle does not include the local CA.";

interface Homebrew {
  readonly prefix: string;
  readonly bundle: string;
  readonly brew: string;
  readonly systemBundle: string;
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
    readonly brewSpawnError?: ProcessExecError;
    readonly env?: (homebrew: Homebrew) => Readonly<Record<string, string>>;
    /** System bundle before setup; it holds the root unless a test says otherwise, and is absent when null. */
    readonly system?: string | null;
    /** System bundle after `mkcert -install`; unchanged when undefined. */
    readonly systemAfterInstall?: string;
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
      systemBundle: join(harness.root, "system.pem"),
    };
    await mkdir(join(prefix, "etc", "ca-certificates"), { recursive: true });
    if (options.formula !== false) await mkdir(join(prefix, "opt", "ca-certificates"), { recursive: true });
    if (options.bundle !== undefined) await writeFile(homebrew.bundle, options.bundle);
    if (options.system !== null)
      await writeFile(homebrew.systemBundle, options.system ?? `${rootB}\n${rootA}`);
    await mkdir(harness.caRoot, { recursive: true });
    await writeFile(join(harness.caRoot, "rootCA.pem"), rootA);
    const { postinstall, brewSpawnError, systemAfterInstall } = options;
    const runner = makeFakeMkcertRunner({
      caRoot: harness.caRoot,
      ...(postinstall === undefined ? {} : { brewPostinstall: () => postinstall(homebrew) }),
      ...(brewSpawnError === undefined ? {} : { brewSpawnError }),
      ...(systemAfterInstall === undefined
        ? {}
        : { afterInstall: () => writeFile(homebrew.systemBundle, systemAfterInstall) }),
    });
    const { ca } = makeCa(harness, runner, {
      env: options.env?.(homebrew) ?? { HOMEBREW_PREFIX: prefix, PATH: "" },
      linuxSystemBundles: [homebrew.systemBundle],
    });
    await body({ homebrew, runner, ca });
  } finally {
    restore();
    await harness.cleanup();
  }
};

const brewCalls = (runner: Runner) => runner.calls().filter((call) => call.args[0] === "postinstall");
const writingCalls = (runner: Runner) =>
  runner.calls().filter(({ args }) => args[0] === "postinstall" || args[0] === "-install");

const rebuildWith =
  (contents: string) =>
  async ({ bundle }: Homebrew): Promise<ProcessResult> => {
    await writeFile(bundle, contents);
    return okResult();
  };

const trustedSystem = (homebrew: Homebrew) => ({
  id: "system",
  name: "System trust store",
  location: homebrew.systemBundle,
  state: "trusted" as const,
});

const brewStore = (homebrew: Homebrew) => ({
  id: "homebrew",
  name: "Homebrew CA bundle",
  location: homebrew.bundle,
});

const untrusted = (remediation: string) => ({
  state: "untrusted" as const,
  reason: "missing",
  detail: LACKS_ROOT,
  remediation,
});

describe("mkcert CertificateAuthority and Homebrew's CA bundle", () => {
  test("setup rebuilds a bundle that lacks the root, without elevation, and reports it changed", async () => {
    await withHomebrew({ bundle: rootB, postinstall: rebuildWith(`${rootB}\n${rootA}`) }, async (input) => {
      // When
      const result = await Effect.runPromise(input.ca.setup({ force: false }));
      // Then
      expect(result.trustStores).toEqual([
        { ...trustedSystem(input.homebrew), changed: false },
        { ...brewStore(input.homebrew), state: "trusted" as const, changed: true },
      ]);
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
        expect(result.trustStores[1]).toEqual({
          ...brewStore(input.homebrew),
          state: "trusted",
          changed: true,
        });
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
      ids: 2,
    },
    {
      name: "the ca-certificates formula is not installed",
      bundle: rootB,
      formula: false,
      env: undefined,
      ids: 1,
    },
    { name: "Homebrew is not installed", bundle: rootB, formula: true, env: () => ({ PATH: "" }), ids: 1 },
  ])(
    "setup runs neither mkcert -install nor brew when the system trusts the root and $name",
    async ({ bundle, formula, env, ids }) => {
      await withHomebrew({ bundle, formula, ...(env === undefined ? {} : { env }) }, async (input) => {
        const privilege = makeFakePrivilege();
        const result = await Effect.runPromise(
          input.ca.setup({ force: false, privilege: privilege.service }),
        );
        expect(result.trustStores.map(({ id, state, changed }) => ({ id, state, changed }))).toEqual(
          ["system", "homebrew"].slice(0, ids).map((id) => ({ id, state: "trusted", changed: false })),
        );
        expect(writingCalls(input.runner)).toEqual([]);
        expect(privilege.calls()).toEqual([]);
      });
    },
  );

  test("setup reports one Homebrew row for a prefix named two ways", async () => {
    await withHomebrew(
      {
        bundle: `${rootB}\n${rootA}`,
        env: ({ prefix }) => ({ HOMEBREW_PREFIX: `${prefix}/`, PATH: join(prefix, "bin", "..", "bin") }),
      },
      async (input) => {
        // Given: the brew on PATH lives in the prefix HOMEBREW_PREFIX names with a trailing slash
        await mkdir(join(input.homebrew.prefix, "bin"), { recursive: true });
        await writeFile(input.homebrew.brew, "#!/bin/sh\n");
        await chmod(input.homebrew.brew, 0o755);
        // When
        const { trustStores } = await Effect.runPromise(input.ca.setup({ force: false }));
        // Then
        expect(trustStores.filter(({ id }) => id === "homebrew")).toEqual([
          { ...brewStore(input.homebrew), state: "trusted", changed: false },
        ]);
      },
    );
  });

  test("setup reports a bundle it cannot read as unknown and does not rebuild it", async () => {
    await withHomebrew({ postinstall: rebuildWith(rootA) }, async (input) => {
      // Given: something that is not a readable file sits where the bundle belongs
      await mkdir(input.homebrew.bundle);
      // When
      const [, brew] = (await Effect.runPromise(input.ca.setup({ force: false }))).trustStores;
      // Then
      expect(brew).toMatchObject({
        ...brewStore(input.homebrew),
        state: "unknown",
        reason: "inspection-failed",
        remediation: `Make ${input.homebrew.bundle} readable, then run \`lando setup\` again.`,
        changed: false,
      });
      expect(brew?.detail).toContain("Lando could not read the bundle");
      expect(brewCalls(input.runner)).toEqual([]);
    });
  });

  test("setup with skipTrustInstall reports a stale bundle and writes nothing", async () => {
    await withHomebrew({ bundle: rootB, postinstall: rebuildWith(rootA) }, async (input) => {
      const privilege = makeFakePrivilege();
      const result = await Effect.runPromise(
        input.ca.setup({ force: false, skipTrustInstall: true, privilege: privilege.service }),
      );
      expect(result.trustStores).toEqual([
        { ...trustedSystem(input.homebrew), changed: false },
        { ...brewStore(input.homebrew), ...untrusted(INSTALL), changed: false },
      ]);
      expect(writingCalls(input.runner)).toEqual([]);
      expect(privilege.calls()).toEqual([]);
    });
  });

  test("setup reports both stores untrusted, and rebuilds nothing, when mkcert leaves the system store without the root", async () => {
    await withHomebrew({ bundle: rootB, system: rootB, postinstall: rebuildWith(rootA) }, async (input) => {
      // When: mkcert -install exits 0 but the system bundle never gains the root
      const result = await Effect.runPromise(input.ca.setup({ force: false }));
      // Then: setup still succeeds
      expect(result.trustStores).toEqual([
        {
          id: "system",
          name: "System trust store",
          location: input.homebrew.systemBundle,
          ...untrusted(INSTALL),
          changed: false,
        },
        { ...brewStore(input.homebrew), ...untrusted(INSTALL), changed: false },
      ]);
      expect(brewCalls(input.runner)).toEqual([]);
    });
  });

  test("setup reports the system store changed once mkcert -install trusts the root", async () => {
    await withHomebrew(
      {
        bundle: rootB,
        system: rootB,
        systemAfterInstall: `${rootB}\n${rootA}`,
        postinstall: rebuildWith(rootA),
      },
      async (input) => {
        const result = await Effect.runPromise(input.ca.setup({ force: false }));
        expect(result.trustStores.map(({ id, state, changed }) => ({ id, state, changed }))).toEqual([
          { id: "system", state: "trusted" as const, changed: true },
          { id: "homebrew", state: "trusted" as const, changed: true },
        ]);
      },
    );
  });

  test("setup does not report a store it could not inspect before as changed", async () => {
    await withHomebrew(
      { bundle: `${rootB}\n${rootA}`, system: null, systemAfterInstall: `${rootB}\n${rootA}` },
      async (input) => {
        // Given: no system bundle is readable before setup, so the system row starts unknown
        // When: mkcert -install leaves one that holds the root
        const result = await Effect.runPromise(input.ca.setup({ force: false }));
        // Then
        expect(result.trustStores.map(({ id, state, changed }) => ({ id, state, changed }))).toEqual([
          { id: "system", state: "trusted" as const, changed: false },
          { id: "homebrew", state: "trusted" as const, changed: false },
        ]);
      },
    );
  });

  test.each([
    {
      name: "brew fails",
      options: {
        postinstall: async (): Promise<ProcessResult> => ({ exitCode: 1, stdout: "", stderr: "Error: no" }),
      },
      reason: "refresh-failed",
      detail: "`brew postinstall ca-certificates` failed: Error: no",
      remediation: "Fix the Homebrew error, then run `lando setup` again.",
    },
    {
      name: "Lando cannot start brew",
      options: {
        brewSpawnError: new ProcessExecError({
          message: "spawn EACCES",
          cmd: "brew",
          remediation: "Fix brew.",
        }),
      },
      reason: "refresh-failed",
      detail: "Lando could not run Homebrew: spawn EACCES",
      remediation: "Fix brew. Then run `lando setup` again.",
    },
    {
      name: "the rebuilt bundle still lacks the root",
      options: { postinstall: rebuildWith(rootB) },
      reason: "missing",
      detail: "Homebrew rebuilt it without the local CA.",
      remediation:
        "Check that the system trust store includes the local CA with `lando doctor`, then run `lando setup` again.",
    },
  ])(
    "setup succeeds and reports the bundle untrusted when $name",
    async ({ options, reason, detail, remediation }) => {
      await withHomebrew({ bundle: rootB, ...options }, async (input) => {
        const result = await Effect.runPromise(input.ca.setup({ force: false }));
        expect(result.trustStores[1]).toEqual({
          ...brewStore(input.homebrew),
          state: "untrusted",
          reason,
          detail,
          remediation,
          changed: false,
        });
      });
    },
  );

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
      const [, brew] = (await Effect.runPromise(input.ca.setup({ force: false }))).trustStores;
      expect(brew?.detail).toContain(
        "Permission denied; Warning: The post-install step did not complete successfully",
      );
      expect(brew?.detail).not.toContain("try again");
    });
  });

  test.each([
    { name: "a bundle without the root", bundle: rootB },
    { name: "a missing bundle while the formula is installed", bundle: undefined },
  ])("trustStores reports $name as untrusted without running brew or mkcert -install", async ({ bundle }) => {
    await withHomebrew(bundle === undefined ? {} : { bundle }, async (input) => {
      await Effect.runPromise(input.ca.setup({ force: false, skipTrustInstall: true }));
      // When
      const stores = await Effect.runPromise(input.ca.trustStores);
      // Then
      expect(stores).toEqual([
        trustedSystem(input.homebrew),
        { ...brewStore(input.homebrew), ...untrusted(INSTALL) },
      ]);
      expect(writingCalls(input.runner)).toEqual([]);
    });
  });

  test("root reports only the certificate and the cached system-store answer", async () => {
    await withHomebrew({ bundle: rootB }, async (input) => {
      await Effect.runPromise(input.ca.setup({ force: false, skipTrustInstall: true }));
      expect(await Effect.runPromise(input.ca.root)).toEqual({ certificate: rootA, trusted: false });
    });
  });
});
