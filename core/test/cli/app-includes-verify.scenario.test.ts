import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { AppIncludesVerifyResultSchema, renderIncludesVerifyResult } from "@lando/core/cli/operations";
import type { IncludeVerifyReport } from "@lando/core/cli/operations";
import type { GitIncludeCloner } from "@lando/landofile/includes";
import { appIncludesVerifySpec } from "../../src/cli/command-specs/app/includes/verify.ts";
import { appIncludesVerify } from "../../src/cli/commands/app-includes-verify.ts";
import { testStateStoreLayer } from "../_support/landofile-layer.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const parseEnvelopeResult = <A>(stdout: string): A => {
  const envelope = JSON.parse(stdout) as { readonly ok?: boolean; readonly result?: unknown };
  expect(envelope.ok).toBe(true);
  return envelope.result as A;
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-includes-verify-cli-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test.each(["recipe: lamp\nconfig:\n  php: '8.3'\n", "recipe: lamp\nconfig: {}\nmounts:\n  - {a: 1}\n"])(
  "includes verify rejects a legacy local layer alongside a valid canonical layer: %s",
  async (legacy) => {
    await withTempCwd(async (dir) => {
      // Given
      const canonicalFile = join(dir, ".lando.yml");
      await writeFile(canonicalFile, "name: native\n");
      await writeFile(join(dir, ".lando.local.yml"), legacy);
      // When
      const error = await Effect.runPromise(
        appIncludesVerify({ cwd: dir }).pipe(Effect.provide(testStateStoreLayer), Effect.flip),
      );
      // Then
      expect(error).toMatchObject({ _tag: "LandofileDialectMixError", canonicalFile });
    });
  },
);

test("verifies typed root layers and fragments with their merged recipe scope", async () => {
  // Given
  await withTempCwd(async (dir) => {
    await writeFile(
      join(dir, ".lando.yml"),
      [
        "name: typed",
        "recipe:",
        "  id: lamp",
        "  version: 0.1.0",
        "  options:",
        "    flag: false",
        "  producer:",
        "    sourceKind: bundled",
        '    packageName: "@lando/recipe-lamp"',
        "    recipeId: lamp",
        "    manifestVersion: 0.1.0",
        `    contentDigest: sha256:${"0".repeat(64)}`,
        "includes:",
        "  - ./fragment.yml",
        "",
      ].join("\n"),
    );
    await writeFile(join(dir, ".lando.base.yml"), 'services:\n  web:\n    primary: "{{ recipe.flag }}"\n');
    await writeFile(join(dir, "fragment.yml"), 'services:\n  api:\n    primary: "{{ recipe.flag }}"\n');
    // When
    const result = await Effect.runPromise(
      appIncludesVerify({ cwd: dir }).pipe(Effect.provide(testStateStoreLayer)),
    );
    // Then
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });
});

test("verifies locked sources from both base and canonical include trees", async () => {
  // Given
  await withTempCwd(async (dir) => {
    const cacheRoot = join(dir, ".cache");
    const fragment = "services: {}\n";
    const checksum = new Bun.CryptoHasher("sha256").update(fragment).digest("hex");
    const sources = [
      { layer: ".lando.base.yml", repo: "base", commit: "a".repeat(40) },
      { layer: ".lando.yml", repo: "canonical", commit: "b".repeat(40) },
    ];
    for (const source of sources) {
      await writeFile(
        join(dir, source.layer),
        `includes:\n  - source: github:acme/${source.repo}\n    path: fragment.yml\n`,
      );
      const cached = join(cacheRoot, "includes", "git", source.commit);
      await mkdir(cached, { recursive: true });
      await writeFile(join(cached, "fragment.yml"), fragment);
    }
    await writeFile(
      join(dir, ".lando.lock.yml"),
      `includes:\n${sources
        .map(
          (source) =>
            `  - source: github:acme/${source.repo}/fragment.yml\n    resolved: ${source.commit}\n    checksum: ${checksum}\n`,
        )
        .join("")}`,
    );
    const gitCloner: GitIncludeCloner = {
      clone: async () => {
        throw new Error("warm verify must stay offline");
      },
    };
    await withEnvVar("LANDO_USER_CACHE_ROOT", cacheRoot, async () => {
      // When
      const report = await Effect.runPromise(
        appIncludesVerify({ cwd: dir, deps: { gitCloner } }).pipe(Effect.provide(testStateStoreLayer)),
      );
      // Then
      expect(report.ok).toBe(true);
      expect(report.entries.map(({ source, status }) => ({ source, status }))).toEqual([
        { source: "github:acme/base/fragment.yml", status: "ok" },
        { source: "github:acme/canonical/fragment.yml", status: "ok" },
      ]);
      expect(report.mismatches).toEqual([]);
    });
  });
});

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const restoreExitCode = <T>(run: () => T): T => {
  const previous = process.exitCode;
  try {
    return run();
  } finally {
    process.exitCode = previous ?? 0;
  }
};

describe("renderIncludesVerifyResult", () => {
  test.each(["json", "yaml"])("a mismatched %s report keeps the machine success exit policy", (format) => {
    // Given
    const report: IncludeVerifyReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [{ source: "a", status: "missing", expected: null, actual: "v:hash" }],
      mismatches: [],
      ok: false,
    };
    // When
    const code = appIncludesVerifySpec.successExitCode?.(report, { flags: { format } });
    // Then
    expect(code).toBeUndefined();
  });
  test("a mismatch names the update command without changing process.exitCode", () => {
    const report: IncludeVerifyReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [
        {
          source: "github:acme/fragments/web.yml",
          status: "mismatch",
          expected: `old:${"a".repeat(64)}`,
          actual: `new:${"b".repeat(64)}`,
        },
      ],
      mismatches: [
        {
          _tag: "LandofileLockMismatchError",
          message: "Landofile include lock mismatch for github:acme/fragments/web.yml.",
          lockfile: "/x/.lando.lock.yml",
          source: "github:acme/fragments/web.yml",
          expected: `old:${"a".repeat(64)}`,
          actual: `new:${"b".repeat(64)}`,
          remediation:
            "Run lando app:includes:update to refresh .lando.lock.yml after reviewing the include change.",
        },
      ],
      ok: false,
    };

    restoreExitCode(() => {
      process.exitCode = 31;
      const text = renderIncludesVerifyResult(report, "text");
      expect(text).toContain("Lockfile does not match");
      expect(text).toContain("app:includes:update");
      expect(process.exitCode).toBe(31);
    });
  });

  test("an ok report does not set a non-zero exit code", () => {
    const report: IncludeVerifyReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [],
      mismatches: [],
      ok: true,
    };

    restoreExitCode(() => {
      process.exitCode = 0;
      renderIncludesVerifyResult(report, "text");
      expect(process.exitCode).toBe(0);
    });
  });

  test("AppIncludesVerifyResultSchema encodes the report including the mismatch schema", () => {
    const report: IncludeVerifyReport = {
      lockfilePath: "/x/.lando.lock.yml",
      entries: [{ source: "a", status: "missing", expected: null, actual: "v:hash" }],
      mismatches: [
        {
          _tag: "LandofileLockMismatchError",
          message: "m",
          lockfile: "/x/.lando.lock.yml",
          source: "a",
          expected: "<missing>",
          actual: "v:hash",
          remediation: "r",
        },
      ],
      ok: false,
    };

    restoreExitCode(() => {
      process.exitCode = 0;
      const encoded = Schema.encodeSync(AppIncludesVerifyResultSchema)(report);
      expect(encoded).toEqual(report);
      expect(encoded.mismatches[0]?._tag).toBe("LandofileLockMismatchError");
    });
  });
});

describe("lando app:includes:verify (source dispatch)", () => {
  test("a Landofile with no includes verifies ok and exits 0", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nrecipe: lamp\n");
      const result = await runCli(["app:includes:verify"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("no remote includes");
    });
  });

  test("rejects unsupported tooling arg metadata before verifying includes", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: demo",
          "tooling:",
          "  echo:",
          "    cmd: echo hi",
          "    args:",
          "      target:",
          "        type: string",
          "",
        ].join("\n"),
      );

      const exit = await Effect.runPromiseExit(
        appIncludesVerify({ cwd: dir }).pipe(Effect.provide(testStateStoreLayer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect((failure.value as { _tag: string; message: string })._tag).toBe("NotImplementedError");
          expect((failure.value as { message: string }).message).toContain('Tooling args field "type"');
        }
      }
    });
  });

  test("rejects a Compose key in the root Landofile before verifying includes", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        "name: demo\nservices:\n  web:\n    image: nginx\n    container_name: fixed-web\n",
      );

      const exit = await Effect.runPromiseExit(
        appIncludesVerify({ cwd: dir }).pipe(Effect.provide(testStateStoreLayer)),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          const value = failure.value;
          if (value === null || typeof value !== "object" || !("_tag" in value)) throw value;
          expect(value._tag).toBe("ComposeKeyRejectedError");
        }
      }
    });
  });

  test("schema failures carry structured issues, including an unknown-key suggestion", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: config-lint-invalid",
          "services:",
          "  web:",
          "    type: compose",
          "    imgae: nginx:1.27-alpine",
          '    home: "nope"',
          "    ports:",
          "      - target: 99999",
          "        protocol: tcp",
          "",
        ].join("\n"),
      );
      const exit = await Effect.runPromiseExit(
        appIncludesVerify({ cwd: dir }).pipe(Effect.provide(testStateStoreLayer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const failure = Cause.findErrorOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag !== "Some") return;
      const value = failure.value as {
        readonly _tag: string;
        readonly issues?: ReadonlyArray<{
          readonly path: ReadonlyArray<string | number>;
          readonly message: string;
          readonly suggestion?: string;
        }>;
      };
      expect(value._tag).toBe("LandofileValidationError");
      const image = value.issues?.find((issue) => issue.path.at(-1) === "imgae");
      expect(image?.suggestion).toBe('Did you mean "image"?');
      expect(value.issues?.some((issue) => issue.path.includes("home"))).toBe(true);
      expect(value.issues?.some((issue) => issue.path.includes("target"))).toBe(true);
    });
  });

  test("a missing Landofile exits 1 with .lando.yml remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:includes:verify"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(".lando.yml");
    });
  });

  test("--format=json with no includes emits an ok report", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nrecipe: lamp\n");
      const result = await runCli(["app:includes:verify", "--format=json"], dir);
      expect(result.exitCode).toBe(0);
      const parsed = parseEnvelopeResult<IncludeVerifyReport>(result.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.entries).toEqual([]);
      expect(parsed.mismatches).toEqual([]);
    });
  });
});
