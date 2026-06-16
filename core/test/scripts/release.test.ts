import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkDeprecationReleaseGate } from "../../../scripts/check-deprecations";
import { CI_PLATFORMS } from "../../../scripts/ci-platforms";
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
      "[release] warning LOCAL_REHEARSAL=1: skip 9-sign (release signing credentials absent)",
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

  test("non-local release fails closed for credential-gated placeholder stages", async () => {
    await expect(
      runRelease({
        deprecationGate: passingDeprecationGate,
        target: "binary",
        throughStage: "9-sign",
        env: {
          LANDO_RELEASE_SIGNING_IDENTITY: "Developer ID Application: Example",
          LANDO_RELEASE_WINDOWS_CERTIFICATE: "cert",
          LANDO_RELEASE_COSIGN_KEY: "key",
        },
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
    try {
      await signingStage.run({
        target: "binary",
        env: { LANDO_RELEASE_SIGNING_IDENTITY: "Developer ID Application: Example" },
        localRehearsal: false,
        runner: {
          spawn: async () => {},
          shell: async () => {},
        },
        logger: () => {},
      });
      throw new Error("expected 9-sign to fail after accepting credentials");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Release stage 9-sign is not implemented yet");
    }
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

    expect([...new Set(spawnStages.map(({ stageId }) => stageId))]).toEqual([
      "1-codegen",
      "2-typecheck",
      "3-lint-format",
      "4-test-gates",
      "7-compile",
    ]);
    expect(spawnStages.some(({ cmd }) => cmd.includes("--target=bun-linux-x64"))).toBe(true);
    expect(logs.some((line) => line.includes("9-sign"))).toBe(false);
  });

  test("compile stage builds every CI platform binary with bytecode", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];
    let now = 0;

    await runRelease({
      deprecationGate: passingDeprecationGate,
      target: "binary",
      throughStage: "7-compile",
      env: localRehearsalEnv,
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
      env: localRehearsalEnv,
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
      env: localRehearsalEnv,
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
