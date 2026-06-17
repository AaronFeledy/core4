import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkDeprecationReleaseGate } from "../../../scripts/check-deprecations";
import { CI_PLATFORMS } from "../../../scripts/ci-platforms";
import { releasePackageNames } from "../../../scripts/prepare-npm-dev-packages";
import { RELEASE_STAGES, redactReleaseCommand, runRelease } from "../../../scripts/release";
import { generateReleaseSboms } from "../../../scripts/release-sbom";

type ReleaseStage = (typeof RELEASE_STAGES)[number];

const passingDeprecationGate = async () => ({ ok: true as const, offenders: [] });

const withReleaseFixtureRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-release-deprecations-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const writeFixtureFile = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

const releaseStage = (id: string): ReleaseStage => {
  const stage = RELEASE_STAGES.find((candidate) => candidate.id === id);
  expect(stage).toBeDefined();
  if (stage === undefined) throw new Error(`missing release stage ${id}`);
  return stage;
};

const withFixtureCwd = async <T>(root: string, run: () => Promise<T>): Promise<T> => {
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    return await run();
  } finally {
    process.chdir(previousCwd);
  }
};

describe("release orchestrator", () => {
  const localRehearsalEnv = { LOCAL_REHEARSAL: "1" };
  const libraryPublishEnv = { LANDO_RELEASE_NPM_TOKEN: "token" };
  const manifestSigningEnv = {
    LANDO_RELEASE_GPG_KEY: "key",
  };
  const provenanceSigningEnv = {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/request",
  };
  const windowsSigningEnv = {
    LANDO_RELEASE_WINDOWS_CERTIFICATE: "certs/windows-release.pfx",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/request",
  };
  const macosSigningEnv = {
    LANDO_RELEASE_SIGNING_IDENTITY: "Developer ID Application: Example",
    LANDO_RELEASE_APPLE_KEYCHAIN_PROFILE: "lando-release",
  };

  test("defines and runs all release stages in the required fixed order", async () => {
    const observed: Array<string> = [];
    const observeStage = (stageId: string): void => {
      if (observed.at(-1) !== stageId) observed.push(stageId);
    };

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "all",
      env: localRehearsalEnv,
      runner: {
        spawn: async ({ stageId }) => {
          observeStage(stageId);
        },
        shell: async ({ stageId }) => {
          observeStage(stageId);
        },
      },
      logger: (line) => {
        const skippedStage = line.match(
          /^\[release\] (?:warning LOCAL_REHEARSAL=1: )?skip (\d+-[a-z-]+)/,
        )?.[1];
        if (skippedStage) observeStage(skippedStage);
      },
    });

    expect(RELEASE_STAGES.map((stage) => stage.id)).toEqual([
      "1-codegen",
      "2-typecheck",
      "3-lint-format",
      "4-test-gates",
      "5-schema-artifacts",
      "6-library-bundle",
      "7-compile",
      "8-strip",
      "9-sign",
      "10-notarize",
      "11-manifest",
      "12-provenance-sbom",
      "13-publish",
    ]);
    expect(observed).toEqual(RELEASE_STAGES.map((stage) => stage.id));
  });

  test("halts on the first failed stage with a tagged release error", async () => {
    const observed: Array<string> = [];

    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "all",
        env: localRehearsalEnv,
        runner: {
          spawn: async ({ stageId }) => {
            observed.push(stageId);
            if (stageId === "4-test-gates") throw new Error("boom");
          },
          shell: async ({ stageId }) => {
            observed.push(stageId);
          },
        },
        logger: () => {},
        now: () => 0,
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "4-test-gates",
      artifactFamily: "binary+library",
      commandSummary: "bun --no-orphans test",
      remediation: "Fix the failed release stage and rerun scripts/release.ts from a clean tree.",
    });

    expect(observed).toEqual(["1-codegen", "2-typecheck", "3-lint-format", "4-test-gates"]);
  });

  test("uses spawn for argv-precise stages and shell for shell-shaped manifest work", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];
    const shellStages: Array<string> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "library",
      throughStage: "11-manifest",
      env: {
        ...manifestSigningEnv,
      },
      runner: {
        spawn: async ({ stageId, cmd }) => {
          spawnStages.push({ stageId, cmd });
        },
        shell: async ({ stageId, script }) => {
          shellStages.push(`${stageId}:${script}`);
        },
      },
      logger: () => {},
      now: () => 0,
    });

    expect(spawnStages).toContainEqual({ stageId: "1-codegen", cmd: ["bun", "run", "scripts/codegen.ts"] });
    expect(spawnStages.filter(({ stageId }) => stageId === "6-library-bundle")).toEqual(
      releasePackageNames.map((packageName) => ({
        stageId: "6-library-bundle",
        cmd: ["bun", "run", `--filter=${packageName}`, "build"],
      })),
    );
    expect(spawnStages).not.toContainEqual({ stageId: "6-library-bundle", cmd: ["bun", "run", "build"] });
    expect(shellStages.some((entry) => entry.startsWith("11-manifest:mkdir -p dist"))).toBe(true);
    expect(shellStages.some((entry) => entry.startsWith("11-manifest:gpg --batch"))).toBe(true);
    expect(shellStages.some((entry) => entry.startsWith("1-codegen:"))).toBe(false);
  });

  test("skips artifact-family stages without changing stage order", async () => {
    const logs: Array<string> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      env: localRehearsalEnv,
      runner: {
        spawn: async ({ stageId }) => {
          logs.push(`run:${stageId}`);
        },
        shell: async ({ stageId }) => {
          logs.push(`run:${stageId}`);
        },
      },
      logger: (line) => logs.push(line),
    });

    expect(logs.filter((line) => line.startsWith("[release] skip 6-library-bundle"))).toHaveLength(1);
    expect(
      logs.filter((line) => line.startsWith("[release] warning LOCAL_REHEARSAL=1: skip 13-publish")),
    ).toHaveLength(1);
    expect(logs).not.toContain("run:13-publish");
    const binaryStageOutcomes = logs
      .map(
        (line) =>
          line.match(/^run:(.+)$/)?.[1] ??
          line.match(/^\[release\] (?:warning LOCAL_REHEARSAL=1: )?skip (\d+-[a-z-]+)/)?.[1],
      )
      .filter((stageId): stageId is string => stageId !== undefined)
      .filter((stageId) => RELEASE_STAGES.some((stage) => stage.id === stageId && stage.forBinary))
      .filter((stageId, index, stageIds) => stageIds.indexOf(stageId) === index);
    expect(binaryStageOutcomes).toEqual(
      RELEASE_STAGES.filter((stage) => stage.forBinary).map((stage) => stage.id),
    );
  });

  test("exposes the required artifact-family stage split", () => {
    expect(RELEASE_STAGES.filter((stage) => stage.forBinary).map((stage) => stage.id)).toEqual([
      "1-codegen",
      "2-typecheck",
      "3-lint-format",
      "4-test-gates",
      "5-schema-artifacts",
      "7-compile",
      "8-strip",
      "9-sign",
      "10-notarize",
      "11-manifest",
      "12-provenance-sbom",
      "13-publish",
    ]);
    expect(RELEASE_STAGES.filter((stage) => stage.forLibrary).map((stage) => stage.id)).toEqual([
      "1-codegen",
      "2-typecheck",
      "3-lint-format",
      "4-test-gates",
      "5-schema-artifacts",
      "6-library-bundle",
      "11-manifest",
      "12-provenance-sbom",
      "13-publish",
    ]);
  });

  test("local rehearsal skips credential-gated work but still writes manifests", async () => {
    const shellStages: Array<{ stageId: string; script: string }> = [];
    const logs: Array<string> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "all",
      env: localRehearsalEnv,
      runner: {
        spawn: async () => {},
        shell: async ({ stageId, script }) => {
          shellStages.push({ stageId, script });
        },
      },
      logger: (line) => logs.push(line),
    });

    expect(logs).toContain(
      "[release] skip 9-sign (selected release platforms are signed at the manifest layer)",
    );
    expect(logs).toContain("[release] skip 10-notarize (no macOS release platform selected)");
    expect(logs).toContain(
      "[release] warning LOCAL_REHEARSAL=1: skip 11-manifest signing (manifest signing credentials absent)",
    );
    expect(logs).toContain(
      "[release] warning LOCAL_REHEARSAL=1: skip 12-provenance-sbom (provenance and cosign credentials absent)",
    );
    expect(logs).toContain(
      "[release] warning LOCAL_REHEARSAL=1: skip 13-publish (publish credentials absent)",
    );

    const manifestScripts = shellStages
      .filter(({ stageId }) => stageId === "11-manifest")
      .map(({ script }) => script);
    expect(manifestScripts.some((script) => script.includes("dist/SHA256SUMS"))).toBe(true);
    expect(manifestScripts.some((script) => script.includes("dist/SHA512SUMS"))).toBe(true);
    expect(manifestScripts.some((script) => script.includes("dist/update-manifest.json"))).toBe(true);
    expect(
      shellStages.some(({ stageId, script }) => stageId === "11-manifest" && script.includes("gpg")),
    ).toBe(false);
    expect(shellStages.some(({ stageId }) => stageId === "12-provenance-sbom")).toBe(false);
    expect(shellStages.some(({ stageId }) => stageId === "13-publish")).toBe(false);
  });

  test("non-local release fails closed for missing platform signing credentials", async () => {
    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "9-sign",
        env: {
          LANDO_RELEASE_SIGNING_IDENTITY: "Developer ID Application: Example",
          LANDO_RELEASE_COSIGN_KEY: "key",
        },
        runner: {
          spawn: async () => {},
          shell: async () => {},
        },
        logger: () => {},
        now: () => 0,
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "9-sign",
      artifactFamily: "binary",
    });
  });

  test("per-platform signing does not require unrelated platform credentials", async () => {
    const macosCommands: Array<ReadonlyArray<string>> = [];
    const windowsCommands: Array<ReadonlyArray<string>> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "9-sign",
      env: { ...macosSigningEnv, LANDO_RELEASE_PLATFORM: "darwin-x64" },
      runner: {
        spawn: async ({ stageId, cmd }) => {
          if (stageId === "9-sign") macosCommands.push(cmd);
        },
        shell: async () => {},
      },
      logger: () => {},
    });

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "9-sign",
      env: { ...windowsSigningEnv, LANDO_RELEASE_PLATFORM: "windows-x64" },
      runner: {
        spawn: async ({ stageId, cmd }) => {
          if (stageId === "9-sign") windowsCommands.push(cmd);
        },
        shell: async () => {},
      },
      logger: () => {},
    });

    expect(macosCommands.map((cmd) => cmd[0])).toEqual(["codesign"]);
    expect(windowsCommands.map((cmd) => cmd[0])).toEqual(["signtool", "cosign", "signtool", "cosign"]);
  });

  test("constructs macOS Developer ID signing commands for both Darwin binaries", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "9-sign",
      env: { ...macosSigningEnv, ...windowsSigningEnv },
      runner: {
        spawn: async ({ stageId, cmd }) => {
          spawnStages.push({ stageId, cmd });
        },
        shell: async () => {},
      },
      logger: () => {},
    });

    expect(spawnStages.filter(({ stageId, cmd }) => stageId === "9-sign" && cmd[0] === "codesign")).toEqual([
      {
        stageId: "9-sign",
        cmd: [
          "codesign",
          "--sign",
          "Developer ID Application: Example",
          "--options",
          "runtime",
          "--timestamp",
          "--entitlements",
          "scripts/lando.entitlements",
          "./dist/lando-darwin-x64",
        ],
      },
      {
        stageId: "9-sign",
        cmd: [
          "codesign",
          "--sign",
          "Developer ID Application: Example",
          "--options",
          "runtime",
          "--timestamp",
          "--entitlements",
          "scripts/lando.entitlements",
          "./dist/lando-darwin-arm64",
        ],
      },
    ]);
  });

  test("submits, staples, and verifies signed macOS artifacts", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "10-notarize",
      env: { ...macosSigningEnv, ...windowsSigningEnv },
      runner: {
        spawn: async ({ stageId, cmd }) => {
          spawnStages.push({ stageId, cmd });
        },
        shell: async () => {},
      },
      logger: () => {},
    });

    expect(spawnStages.filter(({ stageId }) => stageId === "10-notarize")).toEqual([
      {
        stageId: "10-notarize",
        cmd: [
          "xcrun",
          "notarytool",
          "submit",
          "./dist/lando-darwin-x64",
          "--keychain-profile",
          "lando-release",
          "--wait",
        ],
      },
      { stageId: "10-notarize", cmd: ["xcrun", "stapler", "staple", "./dist/lando-darwin-x64"] },
      { stageId: "10-notarize", cmd: ["xcrun", "stapler", "validate", "./dist/lando-darwin-x64"] },
      {
        stageId: "10-notarize",
        cmd: [
          "xcrun",
          "notarytool",
          "submit",
          "./dist/lando-darwin-arm64",
          "--keychain-profile",
          "lando-release",
          "--wait",
        ],
      },
      { stageId: "10-notarize", cmd: ["xcrun", "stapler", "staple", "./dist/lando-darwin-arm64"] },
      { stageId: "10-notarize", cmd: ["xcrun", "stapler", "validate", "./dist/lando-darwin-arm64"] },
    ]);
  });

  test("local rehearsal warning-skips Apple notarization credentials without a keychain profile", async () => {
    const logs: Array<string> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "10-notarize",
      env: {
        LOCAL_REHEARSAL: "1",
        LANDO_RELEASE_PLATFORM: "darwin-x64",
        LANDO_RELEASE_SIGNING_IDENTITY: "Developer ID Application: Example",
        LANDO_RELEASE_APPLE_ID: "maintainer@example.com",
        LANDO_RELEASE_APPLE_PASSWORD: "app-specific-password",
        LANDO_RELEASE_APPLE_TEAM_ID: "TEAMID123",
      },
      runner: {
        spawn: async () => {},
        shell: async () => {},
      },
      logger: (line) => logs.push(line),
      now: () => 0,
    });

    expect(logs).toContain(
      "[release] warning LOCAL_REHEARSAL=1: skip 10-notarize (Apple notarization credentials absent)",
    );
  });

  test("rejects password-shaped Apple notarization credentials before secrets enter argv", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];

    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "10-notarize",
        env: {
          ...windowsSigningEnv,
          LANDO_RELEASE_SIGNING_IDENTITY: "Developer ID Application: Example",
          LANDO_RELEASE_APPLE_ID: "maintainer@example.com",
          LANDO_RELEASE_APPLE_PASSWORD: "app-specific-password",
          LANDO_RELEASE_APPLE_TEAM_ID: "TEAMID123",
        },
        runner: {
          spawn: async ({ stageId, cmd }) => {
            spawnStages.push({ stageId, cmd });
          },
          shell: async () => {},
        },
        logger: () => {},
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "10-notarize",
      artifactFamily: "binary",
    });

    expect(spawnStages.some(({ cmd }) => cmd.includes("app-specific-password"))).toBe(false);
  });

  test("wraps macOS signing command failures in tagged release errors", async () => {
    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "9-sign",
        env: { ...macosSigningEnv, ...windowsSigningEnv },
        runner: {
          spawn: async ({ stageId, cmd }) => {
            if (stageId === "9-sign" && cmd[0] === "codesign") throw new Error("codesign failed");
          },
          shell: async () => {},
        },
        logger: () => {},
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "9-sign",
      artifactFamily: "binary",
    });
  });

  test("non-local release fails closed when provenance credentials are missing", async () => {
    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "library",
        throughStage: "12-provenance-sbom",
        env: manifestSigningEnv,
        runner: {
          spawn: async () => {},
          shell: async () => {},
        },
        logger: () => {},
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "12-provenance-sbom",
      artifactFamily: "library",
    });
  });

  test("provenance cosign requires complete GitHub OIDC credentials", async () => {
    for (const env of [
      { ...manifestSigningEnv, LANDO_RELEASE_PLATFORM: "linux-x64", GITHUB_TOKEN: "token" },
      {
        ...manifestSigningEnv,
        LANDO_RELEASE_PLATFORM: "linux-x64",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
      },
    ]) {
      await expect(
        runRelease({
          deprecationGate: passingDeprecationGate,
          target: "binary",
          throughStage: "12-provenance-sbom",
          env,
          runner: {
            spawn: async () => {},
            shell: async () => {},
          },
          logger: () => {},
        }),
      ).rejects.toMatchObject({
        _tag: "ReleaseStageError",
        stageId: "12-provenance-sbom",
        artifactFamily: "binary",
      });
    }
  });

  describe("Linux checksum manifest signing", () => {
    test("library-only manifests do not require Linux binary artifacts", async () => {
      const shellStages: Array<{ stageId: string; script: string }> = [];

      await runRelease({
        deprecationGate: passingDeprecationGate,
        target: "library",
        throughStage: "11-manifest",
        env: manifestSigningEnv,
        runner: {
          spawn: async () => {},
          shell: async ({ stageId, script }) => {
            shellStages.push({ stageId, script });
          },
        },
        logger: () => {},
      });

      const manifestScript = shellStages.find(
        ({ stageId, script }) => stageId === "11-manifest" && script.includes("SHA256SUMS"),
      )?.script;
      expect(manifestScript).toContain(": > dist/SHA256SUMS");
      expect(manifestScript).toContain(": > dist/SHA512SUMS");
      expect(manifestScript).not.toContain("lando-linux-");
    });

    test("writes Linux checksum manifests and GPG-signs them in the manifest stage", async () => {
      const shellStages: Array<{ stageId: string; script: string }> = [];

      await runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "11-manifest",
        env: { ...macosSigningEnv, ...windowsSigningEnv, ...manifestSigningEnv },
        runner: {
          spawn: async () => {},
          shell: async ({ stageId, script }) => {
            shellStages.push({ stageId, script });
          },
        },
        logger: () => {},
      });

      const manifestScripts = shellStages.filter(({ stageId }) => stageId === "11-manifest");
      expect(manifestScripts[0]?.script).toContain("./dist/lando-linux-arm64");
      expect(manifestScripts[0]?.script).toContain("./dist/lando-linux-x64");
      expect(manifestScripts[0]?.script).toContain('sha256sum "./dist/lando-linux-arm64"');
      expect(manifestScripts[0]?.script).toContain('sha512sum "./dist/lando-linux-x64"');
      expect(manifestScripts[0]?.script).toContain("printf '%s\\n' '{\"schemaVersion\":1,\"artifacts\":{}}'");
      expect(manifestScripts[1]?.script).toContain("gpg --batch --yes --armor --detach-sign dist/SHA256SUMS");
      expect(manifestScripts[1]?.script).toContain("gpg --batch --yes --armor --detach-sign dist/SHA512SUMS");
      expect(manifestScripts[1]?.script).toContain(
        "gpg --batch --verify dist/SHA256SUMS.asc dist/SHA256SUMS",
      );
      expect(manifestScripts[1]?.script).toContain(
        "gpg --batch --verify dist/SHA512SUMS.asc dist/SHA512SUMS",
      );
      expect(manifestScripts.some(({ script }) => script.includes("cosign"))).toBe(false);
    });

    test("checksum manifest generation fails when a required Linux binary is missing", async () => {
      const manifestStage = RELEASE_STAGES.find((stage) => stage.id === "11-manifest");
      expect(manifestStage).toBeDefined();
      if (manifestStage === undefined) throw new Error("missing manifest stage");

      await withReleaseFixtureRoot(async (root) => {
        await mkdir(join(root, "dist"), { recursive: true });
        await writeFile(join(root, "dist", "lando-linux-x64"), "linux-x64", "utf8");
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
          await expect(
            manifestStage.run({
              target: "binary",
              env: {},
              localRehearsal: false,
              runner: {
                spawn: async () => {},
                shell: async ({ script }) => {
                  await Bun.$`sh -euc ${script}`.quiet();
                },
              },
              logger: () => {},
              now: () => 0,
            }),
          ).rejects.toThrow();
        } finally {
          process.chdir(previousCwd);
        }
      });
    });

    test("cosign-signs and verifies SHA256SUMS in the provenance stage before publish", async () => {
      const events: Array<string> = [];
      const provenanceCommands: Array<ReadonlyArray<string>> = [];

      await runRelease({
        deprecationGate: passingDeprecationGate,
        target: "all",
        throughStage: "13-publish",
        env: {
          ...macosSigningEnv,
          ...windowsSigningEnv,
          ...manifestSigningEnv,
          ...provenanceSigningEnv,
          ...libraryPublishEnv,
        },
        runner: {
          spawn: async ({ stageId, cmd }) => {
            events.push(`${stageId}:${cmd.join(" ")}`);
            if (stageId === "12-provenance-sbom") provenanceCommands.push(cmd);
          },
          shell: async ({ stageId, script }) => {
            events.push(`${stageId}:${script.split("\n")[0]}`);
          },
        },
        logger: () => {},
      });

      expect(provenanceCommands).toEqual([
        [
          "cosign",
          "sign-blob",
          "--yes",
          "--output-signature",
          "dist/SHA256SUMS.sig",
          "--output-certificate",
          "dist/SHA256SUMS.crt",
          "dist/SHA256SUMS",
        ],
        [
          "cosign",
          "verify-blob",
          "--certificate-identity-regexp",
          "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$",
          "--certificate-oidc-issuer",
          "https://token.actions.githubusercontent.com",
          "--signature",
          "dist/SHA256SUMS.sig",
          "--certificate",
          "dist/SHA256SUMS.crt",
          "dist/SHA256SUMS",
        ],
      ]);
      const verifyIndex = events.findIndex((event) =>
        event.includes("12-provenance-sbom:cosign verify-blob"),
      );
      const publishIndex = events.findIndex((event) => event.startsWith("13-publish:before_latest"));
      expect(verifyIndex).toBeGreaterThanOrEqual(0);
      expect(publishIndex).toBeGreaterThan(verifyIndex);
    });

    test("local rehearsal warning-skips incomplete provenance credentials", async () => {
      const logs: Array<string> = [];
      const spawnStages: Array<string> = [];

      await runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "12-provenance-sbom",
        env: {
          LOCAL_REHEARSAL: "1",
          LANDO_RELEASE_PLATFORM: "linux-x64",
          ...manifestSigningEnv,
          GITHUB_TOKEN: "token",
        },
        runner: {
          spawn: async ({ stageId }) => {
            spawnStages.push(stageId);
          },
          shell: async () => {},
        },
        logger: (line) => logs.push(line),
      });

      expect(logs).toContain(
        "[release] warning LOCAL_REHEARSAL=1: skip 12-provenance-sbom (provenance and cosign credentials absent)",
      );
      expect(spawnStages).not.toContain("12-provenance-sbom");
    });

    test("generates CycloneDX SBOMs for release artifacts and links them from the manifest", async () => {
      const provenanceStage = releaseStage("12-provenance-sbom");

      await withReleaseFixtureRoot(async (root) => {
        await writeFixtureFile(root, "dist/lando-linux-arm64", "linux-arm64 artifact");
        await writeFixtureFile(root, "dist/lando-linux-x64", "linux-x64 artifact");
        await writeFixtureFile(root, "dist/lando-library-0.0.0.tgz", "library archive");
        await writeFixtureFile(root, "dist/update-manifest.json", '{"schemaVersion":1,"artifacts":{}}');

        await withFixtureCwd(root, async () => {
          await provenanceStage.run({
            target: "all",
            env: { ...provenanceSigningEnv, LANDO_RELEASE_PLATFORM: "linux-x64" },
            localRehearsal: false,
            runner: {
              spawn: async () => {},
              shell: async ({ script }) => {
                await Bun.$`sh -euc ${script}`.quiet();
              },
            },
            logger: () => {},
            now: () => 0,
          });
        });

        const manifest = JSON.parse(await readFile(join(root, "dist", "update-manifest.json"), "utf8"));
        const linuxEntry = manifest.artifacts["lando-linux-x64"];
        expect(linuxEntry.path).toBe("dist/lando-linux-x64");
        expect(linuxEntry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(linuxEntry.sbom.path).toBe("dist/lando-linux-x64-0.0.0-sbom.cdx.json");
        expect(linuxEntry.sbom.sha256).toMatch(/^[0-9a-f]{64}$/);

        const sbom = JSON.parse(await readFile(join(root, linuxEntry.sbom.path), "utf8"));
        expect(sbom.bomFormat).toBe("CycloneDX");
        expect(sbom.specVersion).toBe("1.6");
        expect(sbom.metadata.component.name).toBe("lando-linux-x64");
        expect(sbom.metadata.component.version).toBe("0.0.0");
        expect(sbom.metadata.component.hashes[0]).toEqual({ alg: "SHA-256", content: linuxEntry.sha256 });
        expect(sbom.metadata.tools.components[0].name).toBe("@lando/core release-sbom");
        expect(sbom.components.map((component: { name: string }) => component.name)).toContain("@lando/core");
        expect(manifest.artifacts["lando-library-0.0.0.tgz"].sbom.path).toBe(
          "dist/lando-library-0.0.0-sbom.cdx.json",
        );
      });
    });

    test("provenance stage fails when a manifest artifact lacks a matching SBOM", async () => {
      const provenanceStage = releaseStage("12-provenance-sbom");

      await withReleaseFixtureRoot(async (root) => {
        await writeFixtureFile(root, "dist/lando-linux-x64", "linux-x64 artifact");
        await writeFixtureFile(
          root,
          "dist/update-manifest.json",
          JSON.stringify({
            schemaVersion: 1,
            artifacts: {
              "missing-artifact": { kind: "binary", path: "dist/missing-artifact", sha256: "a".repeat(64) },
            },
          }),
        );

        await withFixtureCwd(root, async () => {
          await expect(
            provenanceStage.run({
              target: "binary",
              env: { ...provenanceSigningEnv, LANDO_RELEASE_PLATFORM: "linux-x64" },
              localRehearsal: false,
              runner: {
                spawn: async () => {},
                shell: async ({ script }) => {
                  const proc = Bun.spawn(["sh", "-euc", script], { stderr: "pipe", stdout: "pipe" });
                  const stderr = await new Response(proc.stderr).text();
                  const exitCode = await proc.exited;
                  if (exitCode !== 0) throw new Error(stderr);
                },
              },
              logger: () => {},
              now: () => 0,
            }),
          ).rejects.toThrow("lacks a matching SBOM");
        });
      });
    });

    test("SBOM generation can complete manifest entries created before stage 12", async () => {
      await withReleaseFixtureRoot(async (root) => {
        await writeFixtureFile(root, "dist/lando-linux-x64", "linux-x64 artifact");
        await writeFixtureFile(
          root,
          "dist/update-manifest.json",
          JSON.stringify({
            schemaVersion: 1,
            artifacts: {
              "lando-linux-x64": { kind: "binary", path: "dist/lando-linux-x64", sha256: "a".repeat(64) },
            },
          }),
        );

        await withFixtureCwd(root, async () => {
          const manifest = await generateReleaseSboms({
            version: "0.0.0",
            manifestPath: "dist/update-manifest.json",
            artifacts: [{ kind: "binary", path: "dist/lando-linux-x64" }],
          });

          expect(manifest.artifacts["lando-linux-x64"]?.sbom?.path).toBe(
            "dist/lando-linux-x64-0.0.0-sbom.cdx.json",
          );
        });
      });
    });
  });

  describe("Windows release signing", () => {
    test("signs with signtool, cosign-signs the signed bytes, then verifies before manifest generation", async () => {
      const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];
      const logs: Array<string> = [];

      await runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "11-manifest",
        env: { ...windowsSigningEnv, LOCAL_REHEARSAL: "1", LANDO_RELEASE_PLATFORM: "windows-x64" },
        runner: {
          spawn: async ({ stageId, cmd }) => {
            spawnStages.push({ stageId, cmd });
          },
          shell: async () => {},
        },
        logger: (line) => logs.push(line),
      });

      const signingCommands = spawnStages.filter(({ stageId }) => stageId === "9-sign").map(({ cmd }) => cmd);
      expect(signingCommands).toEqual([
        [
          "signtool",
          "sign",
          "/tr",
          "http://timestamp.digicert.com",
          "/td",
          "sha256",
          "/fd",
          "sha256",
          "/f",
          "certs/windows-release.pfx",
          "dist/lando-windows-x64.exe",
        ],
        [
          "cosign",
          "sign-blob",
          "--yes",
          "--output-signature",
          "dist/lando-windows-x64.exe.sig",
          "--output-certificate",
          "dist/lando-windows-x64.exe.crt",
          "dist/lando-windows-x64.exe",
        ],
        ["signtool", "verify", "/pa", "/v", "dist/lando-windows-x64.exe"],
        [
          "cosign",
          "verify-blob",
          "--certificate-identity-regexp",
          "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$",
          "--certificate-oidc-issuer",
          "https://token.actions.githubusercontent.com",
          "--signature",
          "dist/lando-windows-x64.exe.sig",
          "--certificate",
          "dist/lando-windows-x64.exe.crt",
          "dist/lando-windows-x64.exe",
        ],
      ]);
      expect(spawnStages.findIndex(({ stageId }) => stageId === "9-sign")).toBeLessThan(
        logs.findIndex((line) => line.startsWith("[release] -> 11-manifest")),
      );
    });

    test("supports configured timestamp URL, certificate password, and certificate identity verification", async () => {
      const signingCommands: Array<ReadonlyArray<string>> = [];

      await runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "9-sign",
        env: {
          ...windowsSigningEnv,
          LOCAL_REHEARSAL: "1",
          LANDO_RELEASE_PLATFORM: "windows-x64",
          LANDO_RELEASE_WINDOWS_CERTIFICATE_PASSWORD: "secret",
          LANDO_RELEASE_WINDOWS_TIMESTAMP_URL: "http://timestamp.example.test",
          LANDO_RELEASE_COSIGN_CERTIFICATE_IDENTITY_REGEXP: "^https://github.com/example/repo/.+$",
        },
        runner: {
          spawn: async ({ stageId, cmd }) => {
            if (stageId === "9-sign") signingCommands.push(cmd);
          },
          shell: async () => {},
        },
        logger: () => {},
      });

      expect(signingCommands[0]).toEqual([
        "signtool",
        "sign",
        "/tr",
        "http://timestamp.example.test",
        "/td",
        "sha256",
        "/fd",
        "sha256",
        "/f",
        "certs/windows-release.pfx",
        "/p",
        "secret",
        "dist/lando-windows-x64.exe",
      ]);
      expect(signingCommands[3]).toContain("^https://github.com/example/repo/.+$");
    });

    test("maps signtool and cosign failures to the signing stage", async () => {
      await expect(
        runRelease({
          deprecationGate: passingDeprecationGate,
          target: "binary",
          throughStage: "9-sign",
          env: { ...windowsSigningEnv, LOCAL_REHEARSAL: "1", LANDO_RELEASE_PLATFORM: "windows-x64" },
          runner: {
            spawn: async ({ stageId, cmd }) => {
              if (stageId === "9-sign" && cmd[0] === "cosign") throw new Error("cosign unavailable");
            },
            shell: async () => {},
          },
          logger: () => {},
        }),
      ).rejects.toMatchObject({
        _tag: "ReleaseStageError",
        stageId: "9-sign",
        artifactFamily: "binary",
        commandSummary: "sign release binaries",
      });
    });

    test("redacts the certificate password from command failure messages", () => {
      const failureMessage = redactReleaseCommand([
        "signtool",
        "sign",
        "/tr",
        "http://timestamp.digicert.com",
        "/td",
        "sha256",
        "/fd",
        "sha256",
        "/f",
        "certs/windows-release.pfx",
        "/p",
        "super-secret-password",
        "dist/lando-windows-x64.exe",
      ]);

      expect(failureMessage).not.toContain("super-secret-password");
      expect(failureMessage).toContain("/p ***");
      expect(failureMessage).toContain("certs/windows-release.pfx");
    });
  });

  test("publish and manifest signing require complete credentials", async () => {
    const shellStages: Array<{ stageId: string; script: string }> = [];
    const logs: Array<string> = [];

    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "library",
        throughStage: "13-publish",
        env: { GITHUB_TOKEN: "token" },
        runner: {
          spawn: async () => {},
          shell: async ({ stageId, script }) => {
            shellStages.push({ stageId, script });
          },
        },
        logger: () => {},
        now: () => 0,
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "11-manifest",
    });
    expect(
      shellStages.some(({ stageId, script }) => stageId === "11-manifest" && script.includes("gpg")),
    ).toBe(false);

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "library",
      throughStage: "13-publish",
      env: { LOCAL_REHEARSAL: "1", GITHUB_TOKEN: "token" },
      runner: {
        spawn: async () => {},
        shell: async ({ stageId, script }) => {
          shellStages.push({ stageId, script });
        },
      },
      logger: (line) => logs.push(line),
      now: () => 0,
    });
    expect(logs).toContain(
      "[release] warning LOCAL_REHEARSAL=1: skip 13-publish (publish credentials absent)",
    );

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "library",
      throughStage: "13-publish",
      env: { LOCAL_REHEARSAL: "1", ...manifestSigningEnv, ...libraryPublishEnv },
      runner: {
        spawn: async () => {},
        shell: async ({ stageId, script }) => {
          shellStages.push({ stageId, script });
        },
      },
      logger: (line) => logs.push(line),
    });
    expect(logs).toContain(
      "[release] warning LOCAL_REHEARSAL=1: skip 13-publish (local rehearsal never publishes)",
    );
    expect(
      shellStages.some(({ stageId, script }) => stageId === "13-publish" && script.includes("npm publish")),
    ).toBe(false);
  });

  test("credential gates accept manifest alternatives but keep Windows signing scoped", async () => {
    const shellStages: Array<{ stageId: string; script: string }> = [];
    const manifestStage = RELEASE_STAGES.find((stage) => stage.id === "11-manifest");
    const signingStage = RELEASE_STAGES.find((stage) => stage.id === "9-sign");
    expect(manifestStage).toBeDefined();
    expect(signingStage).toBeDefined();
    if (manifestStage === undefined || signingStage === undefined) throw new Error("missing release stage");

    await expect(
      manifestStage.run({
        target: "all",
        env: {},
        localRehearsal: false,
        runner: {
          spawn: async () => {},
          shell: async ({ stageId, script }) => {
            shellStages.push({ stageId, script });
          },
        },
        logger: () => {},
        now: () => 0,
      }),
    ).rejects.toThrow("Missing manifest signing credentials");

    await manifestStage.run({
      target: "all",
      env: { GPG_PRIVATE_KEY: "key" },
      localRehearsal: false,
      runner: {
        spawn: async () => {},
        shell: async ({ stageId, script }) => {
          shellStages.push({ stageId, script });
        },
      },
      logger: () => {},
      now: () => 0,
    });

    expect(
      shellStages.some(({ stageId, script }) => stageId === "11-manifest" && script.includes("gpg")),
    ).toBe(true);
    await expect(
      signingStage.run({
        target: "binary",
        env: { LANDO_RELEASE_SIGNING_IDENTITY: "Developer ID Application: Example" },
        localRehearsal: false,
        runner: {
          spawn: async () => {},
          shell: async () => {},
        },
        logger: () => {},
        now: () => 0,
      }),
    ).rejects.toThrow("Missing Windows signing credentials");
  });

  test("publish runs for the all target but skips binary-only releases", async () => {
    const publishStage = RELEASE_STAGES.find((stage) => stage.id === "13-publish");
    const shellStages: Array<{ stageId: string; script: string }> = [];
    const logs: Array<string> = [];
    expect(publishStage).toBeDefined();
    if (publishStage === undefined) throw new Error("missing publish stage");

    await publishStage.run({
      target: "all",
      env: libraryPublishEnv,
      localRehearsal: false,
      runner: {
        spawn: async () => {},
        shell: async ({ stageId, script }) => {
          shellStages.push({ stageId, script });
        },
      },
      logger: (line) => logs.push(line),
      now: () => 0,
    });

    await publishStage.run({
      target: "binary",
      env: libraryPublishEnv,
      localRehearsal: false,
      runner: {
        spawn: async () => {},
        shell: async ({ stageId, script }) => {
          shellStages.push({ stageId, script });
        },
      },
      logger: (line) => logs.push(line),
      now: () => 0,
    });

    expect(
      shellStages.filter(({ stageId, script }) => stageId === "13-publish" && script.includes("npm publish")),
    ).toHaveLength(1);
    expect(logs).toContain("[release] skip 13-publish (binary release target)");
  });

  test("local rehearsal compiles the Windows release artifact before signing", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];
    const logs: Array<string> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "7-compile",
      env: { ...localRehearsalEnv, LANDO_RELEASE_PLATFORM: "windows-x64" },
      runner: {
        spawn: async ({ stageId, cmd }) => {
          spawnStages.push({ stageId, cmd });
        },
        shell: async () => {},
      },
      logger: (line) => logs.push(line),
    });

    expect([...new Set(spawnStages.map(({ stageId }) => stageId))]).toEqual([
      "1-codegen",
      "2-typecheck",
      "3-lint-format",
      "4-test-gates",
      "7-compile",
    ]);
    expect(spawnStages.at(-2)?.cmd).toEqual([
      "bun",
      "build",
      "./core/bin/lando.ts",
      "--compile",
      "--bytecode",
      "--target=bun-windows-x64",
      "--outfile=./dist/lando-windows-x64.exe",
      "--sourcemap=external",
    ]);
    expect(spawnStages.at(-1)?.cmd).toEqual([
      "bun",
      "run",
      "scripts/sanitize-compiled-binary.ts",
      "./dist/lando-windows-x64.exe",
    ]);
    expect(spawnStages.some(({ cmd }) => cmd.includes("--target=bun-linux-x64"))).toBe(false);
    expect(logs.some((line) => line.includes("9-sign"))).toBe(false);
  });

  test("compile stage builds every CI platform binary with bytecode", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];
    let now = 0;

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "7-compile",
      env: {},
      now: () => now,
      runner: {
        spawn: async ({ stageId, cmd }) => {
          spawnStages.push({ stageId, cmd });
          if (stageId === "7-compile" && cmd[0] === "bun" && cmd[1] === "build") now += 42_000;
        },
        shell: async () => {},
      },
      logger: () => {},
    });

    const compileCommands = spawnStages.filter(({ stageId }) => stageId === "7-compile");
    expect(compileCommands.map(({ cmd }) => cmd)).toEqual(
      CI_PLATFORMS.flatMap((platform) => {
        const outfile = `./dist/lando-${platform.id}${platform.id === "windows-x64" ? ".exe" : ""}`;
        return [
          [
            "bun",
            "build",
            "./core/bin/lando.ts",
            "--compile",
            "--bytecode",
            `--target=${platform.bunTarget}`,
            `--outfile=${outfile}`,
            "--sourcemap=external",
          ],
          ["bun", "run", "scripts/sanitize-compiled-binary.ts", outfile],
        ];
      }),
    );
    expect(CI_PLATFORMS.map((platform) => platform.id)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "windows-x64",
    ]);
  });

  test("compile stage reports duration and fails the linux-x64 cold-build budget", async () => {
    let now = 0;
    const failure = await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "7-compile",
      env: {},
      now: () => now,
      runner: {
        spawn: async ({ stageId, cmd }) => {
          if (stageId !== "7-compile" || cmd[0] !== "bun" || cmd[1] !== "build") return;
          now += cmd.includes("--target=bun-linux-x64") ? 600_001 : 10_000;
        },
        shell: async () => {},
      },
      logger: () => {},
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "7-compile",
      artifactFamily: "binary",
      cause: {
        _tag: "ReleaseCompileBudgetError",
        platformId: "linux-x64",
        durationMs: 600_001,
        budgetMs: 600_000,
      },
    });
  });

  test("local rehearsal reports compile duration before later credential skips", async () => {
    const logs: Array<string> = [];
    let now = 0;

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "10-notarize",
      env: { ...localRehearsalEnv, LANDO_RELEASE_PLATFORM: "linux-x64" },
      now: () => now,
      runner: {
        spawn: async ({ stageId, cmd }) => {
          if (stageId === "7-compile" && cmd[0] === "bun" && cmd[1] === "build") now += 25_000;
        },
        shell: async () => {},
      },
      logger: (line) => logs.push(line),
    });

    const compileDurationIndex = logs.findIndex((line) =>
      line.includes("[release] compile linux-x64 completed in 25000ms (budget 600000ms)"),
    );
    const signingSkipIndex = logs.findIndex((line) => line.includes("skip 9-sign"));
    const notarizeSkipIndex = logs.findIndex((line) => line.includes("skip 10-notarize"));
    expect(compileDurationIndex).toBeGreaterThanOrEqual(0);
    expect(signingSkipIndex).toBeGreaterThan(compileDurationIndex);
    expect(notarizeSkipIndex).toBeGreaterThan(compileDurationIndex);
  });

  describe("deprecation gate", () => {
    test("runs the deprecation gate after codegen and before type-check", async () => {
      const events: Array<string> = [];

      await runRelease({
        target: "all",
        env: localRehearsalEnv,
        deprecationGate: async () => {
          events.push("deprecation-gate");
          return { ok: true, offenders: [] };
        },
        runner: {
          spawn: async ({ stageId }) => {
            events.push(stageId);
          },
          shell: async ({ stageId }) => {
            events.push(stageId);
          },
        },
        logger: () => {},
      });

      const codegenIndex = events.indexOf("1-codegen");
      const gateIndex = events.indexOf("deprecation-gate");
      const typecheckIndex = events.indexOf("2-typecheck");
      expect(codegenIndex).toBeGreaterThanOrEqual(0);
      expect(gateIndex).toBe(codegenIndex + 1);
      expect(typecheckIndex).toBe(gateIndex + 1);
    });

    test("blocks the release when a deprecation removeIn has arrived (synthetic fixture)", async () => {
      await withReleaseFixtureRoot(async (root) => {
        await writeFixtureFile(
          root,
          "sdk/src/public.ts",
          `
            import { Effect } from "effect";
            import { markDeprecated } from "@lando/sdk/services";
            const staleNotice = { since: "4.1.0", removeIn: "5.0.0", note: "Use newApi instead." };
            /** @deprecated Deprecated since 4.1.0; remove in 5.0.0. Use newApi instead. */
            export const staleApi = markDeprecated(staleNotice, "staleApi", () => Effect.succeed("ok"));
          `,
        );

        const failure = await runRelease({
          target: "all",
          throughStage: "2-typecheck",
          env: {},
          deprecationGate: ({ env }) =>
            checkDeprecationReleaseGate({
              root,
              targetRelease: "5.0.0",
              releasedOrPending: ["4.1.0", "4.2.0", "5.0.0", "5.1.0"],
              env,
            }),
          runner: {
            spawn: async () => {},
            shell: async () => {},
          },
          logger: () => {},
        }).then(
          () => undefined,
          (error: unknown) => error,
        );

        expect(failure).toMatchObject({ _tag: "ReleaseStageError", stageId: "deprecation-gate" });
        const cause = (failure as { cause: Error }).cause;
        expect(cause).toBeInstanceOf(Error);
        const message = cause.message;
        expect(message).toContain("staleApi");
        expect(message).toContain("sdk/src/public.ts");
        expect(message).toContain("removeIn=5.0.0");
        expect(message).toContain("Remove staleApi before releasing 5.0.0");
      });
    });

    test("formats each blocked surface with file, removeIn, and the removal action", async () => {
      const failure = await runRelease({
        target: "all",
        throughStage: "2-typecheck",
        env: {},
        deprecationGate: async () => ({
          ok: false,
          offenders: [
            {
              file: "/tmp/example/sdk/src/public.ts",
              line: 7,
              exportName: "staleApi",
              reason: "DeprecationStaleError: surface is still present at removeIn 5.0.0",
              removeIn: "5.0.0",
              expectedAction: "Remove staleApi before releasing 5.0.0; its removeIn (5.0.0) has arrived.",
            },
          ],
        }),
        runner: {
          spawn: async () => {},
          shell: async () => {},
        },
        logger: () => {},
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({
        _tag: "ReleaseStageError",
        stageId: "deprecation-gate",
        artifactFamily: "binary+library",
        commandSummary: "bun run scripts/check-deprecations.ts",
      });
      const message = (failure as { cause: Error }).cause.message;
      expect(message).toContain("staleApi");
      expect(message).toContain("public.ts:7");
      expect(message).toContain("removeIn=5.0.0");
      expect(message).toContain("Remove staleApi before releasing 5.0.0; its removeIn (5.0.0) has arrived.");
    });

    test("runs the same deprecation gate in local rehearsal and CI release mode", async () => {
      const calls: Array<boolean> = [];
      const recordingGate = (localRehearsal: boolean) => async () => {
        calls.push(localRehearsal);
        return { ok: true as const, offenders: [] };
      };

      for (const local of [true, false]) {
        await runRelease({
          target: "all",
          throughStage: "2-typecheck",
          env: local ? { LOCAL_REHEARSAL: "1" } : {},
          deprecationGate: recordingGate(local),
          runner: {
            spawn: async () => {},
            shell: async () => {},
          },
          logger: () => {},
        });
      }

      expect(calls).toEqual([true, false]);
    });
  });
});
