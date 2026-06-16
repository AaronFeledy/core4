import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkDeprecationReleaseGate } from "../../../scripts/check-deprecations";
import { releasePackageNames } from "../../../scripts/prepare-npm-dev-packages";
import { RELEASE_STAGES, runRelease } from "../../../scripts/release";

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

describe("release orchestrator", () => {
  const localRehearsalEnv = { LOCAL_REHEARSAL: "1" };
  const libraryPublishEnv = { LANDO_RELEASE_NPM_TOKEN: "token" };
  const manifestSigningEnv = {
    LANDO_RELEASE_GPG_KEY: "key",
    LANDO_RELEASE_COSIGN_KEY: "key",
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
      "[release] warning LOCAL_REHEARSAL=1: skip 9-sign (macOS Developer ID signing identity absent)",
    );
    expect(logs).toContain(
      "[release] warning LOCAL_REHEARSAL=1: skip 10-notarize (Apple notarization credentials absent)",
    );
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

  test("non-local release fails closed for missing credential-gated stages", async () => {
    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "9-sign",
        env: {},
        runner: {
          spawn: async () => {},
          shell: async () => {},
        },
        logger: () => {},
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "9-sign",
      artifactFamily: "binary",
    });

    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "library",
        throughStage: "12-provenance-sbom",
        env: {
          ...manifestSigningEnv,
          GITHUB_TOKEN: "token",
          LANDO_RELEASE_OIDC_TOKEN: "oidc",
        },
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

  test("constructs macOS Developer ID signing commands for both Darwin binaries", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];

    await runRelease({
      target: "binary",
      throughStage: "9-sign",
      env: macosSigningEnv,
      runner: {
        spawn: async ({ stageId, cmd }) => {
          spawnStages.push({ stageId, cmd });
        },
        shell: async () => {},
      },
      logger: () => {},
    });

    expect(spawnStages.filter(({ stageId }) => stageId === "9-sign")).toEqual([
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
      target: "binary",
      throughStage: "10-notarize",
      env: macosSigningEnv,
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
      target: "binary",
      throughStage: "10-notarize",
      env: {
        LOCAL_REHEARSAL: "1",
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
    });

    expect(logs).toContain(
      "[release] warning LOCAL_REHEARSAL=1: skip 10-notarize (Apple notarization credentials absent)",
    );
  });

  test("rejects password-shaped Apple notarization credentials before secrets enter argv", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];

    await expect(
      runRelease({
        target: "binary",
        throughStage: "10-notarize",
        env: {
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
        target: "binary",
        throughStage: "9-sign",
        env: macosSigningEnv,
        runner: {
          spawn: async ({ stageId }) => {
            if (stageId === "9-sign") throw new Error("codesign failed");
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

  test("credential gates accept any declared credential alternative", async () => {
    const shellStages: Array<{ stageId: string; script: string }> = [];
    const manifestStage = RELEASE_STAGES.find((stage) => stage.id === "11-manifest");
    const signingStage = RELEASE_STAGES.find((stage) => stage.id === "9-sign");
    expect(manifestStage).toBeDefined();
    expect(signingStage).toBeDefined();
    if (manifestStage === undefined || signingStage === undefined) throw new Error("missing release stage");

    await expect(
      manifestStage.run({
        target: "all",
        env: { LANDO_RELEASE_GPG_KEY: "key" },
        localRehearsal: false,
        runner: {
          spawn: async () => {},
          shell: async ({ stageId, script }) => {
            shellStages.push({ stageId, script });
          },
        },
        logger: () => {},
      }),
    ).rejects.toThrow("Missing manifest signing credentials");

    await manifestStage.run({
      target: "all",
      env: { GPG_PRIVATE_KEY: "key", COSIGN_PRIVATE_KEY: "key" },
      localRehearsal: false,
      runner: {
        spawn: async () => {},
        shell: async ({ stageId, script }) => {
          shellStages.push({ stageId, script });
        },
      },
      logger: () => {},
    });

    expect(
      shellStages.some(({ stageId, script }) => stageId === "11-manifest" && script.includes("gpg")),
    ).toBe(true);
    await signingStage.run({
      target: "binary",
      env: { LANDO_RELEASE_SIGNING_IDENTITY: "Developer ID Application: Example" },
      localRehearsal: false,
      runner: {
        spawn: async ({ stageId, cmd }) => {
          shellStages.push({ stageId, script: cmd.join(" ") });
        },
        shell: async () => {},
      },
      logger: () => {},
    });

    expect(
      shellStages.some(({ stageId, script }) => stageId === "9-sign" && script.includes("codesign")),
    ).toBe(true);
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
    });

    expect(
      shellStages.filter(({ stageId, script }) => stageId === "13-publish" && script.includes("npm publish")),
    ).toHaveLength(1);
    expect(logs).toContain("[release] skip 13-publish (binary release target)");
  });

  test("local rehearsal can run the compile prefix for the current platform without signing secrets", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];
    const logs: Array<string> = [];

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "7-compile",
      env: localRehearsalEnv,
      runner: {
        spawn: async ({ stageId, cmd }) => {
          spawnStages.push({ stageId, cmd });
        },
        shell: async () => {},
      },
      logger: (line) => logs.push(line),
    });

    expect(spawnStages.map(({ stageId }) => stageId)).toEqual([
      "1-codegen",
      "2-typecheck",
      "3-lint-format",
      "4-test-gates",
      "7-compile",
    ]);
    expect(spawnStages.at(-1)?.cmd).toEqual(["bun", "run", "--filter=@lando/core", "build:compile"]);
    expect(logs.some((line) => line.includes("9-sign"))).toBe(false);
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
