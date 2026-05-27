import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { makeRuntimeProvider, providerStatePath } from "@lando/provider-lando";
import { type AppPlan, ProviderId } from "@lando/sdk/schema";
import { setupSpec } from "../../src/cli/oclif/commands/meta/setup.ts";

const coreRoot = resolve(import.meta.dirname, "../..");
const sourceCliPath = resolve(coreRoot, "bin/lando.ts");
const binaryDir = resolve(coreRoot, "dist");
const binaryPath = resolve(coreRoot, "dist/lando");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (
  cmd: Array<string>,
  cwd = coreRoot,
  env: Readonly<Record<string, string>> = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({ cmd, cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const stripAnsi = (value: string): string => {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") index += 1;
      continue;
    }
    output += value[index];
  }
  return output;
};

const normalizeSetupFailure = (stderr: string): string =>
  stripAnsi(stderr)
    .split("\n")
    .map((line) => line.trim().replace(/^.*Error: /u, ""))
    .filter((line) => line.includes("Podman") || line.includes("Install Podman"))
    .join("\n");

describe("meta:setup command", () => {
  test("invokes the selected runtime provider setup and renders the install dir", async () => {
    let setupCalls = 0;
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      setup: () =>
        Effect.sync(() => {
          setupCalls += 1;
        }),
    };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    const result = await Effect.runPromise(
      setupSpec
        .run({ installDir: "/opt/lando" })
        .pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, registry))),
    );

    expect(setupCalls).toBe(1);
    expect(setupSpec.render?.(result)).toBe(
      'setup complete: Lando runtime (lando)\nLANDO_INSTALL_DIR="/opt/lando"',
    );
  });

  test("honors an explicit provider flag when selecting setup provider", async () => {
    let selectedProvider: string | undefined;
    let setupCalls = 0;
    const provider = {
      ...TestRuntimeProvider,
      id: "podman",
      setup: () =>
        Effect.sync(() => {
          setupCalls += 1;
        }),
    };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando"), ProviderId.make("podman")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: (plan?: AppPlan) => {
        selectedProvider = plan?.provider === undefined ? undefined : String(plan.provider);
        return Effect.succeed(provider);
      },
    };

    const result = await Effect.runPromise(
      setupSpec
        .run({ installDir: "/opt/lando", flags: { provider: "podman" } })
        .pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, registry))),
    );

    expect(selectedProvider).toBe("podman");
    expect(setupCalls).toBe(1);
    expect(setupSpec.render?.(result)).toBe(
      'setup complete: Lando runtime (podman)\nLANDO_INSTALL_DIR="/opt/lando"',
    );
  });

  test("invokes provider-lando setup with fake bundle and Podman API clients", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-setup-command-"));
    const bundleBytes = new TextEncoder().encode("fake lando runtime bundle");
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        podmanApi: { info: Effect.succeed({ version: { Version: "5.2.0" } }) },
        podmanCommand: { version: Effect.succeed("podman version 5.2.0") },
        runtimeBundleDownloader: {
          download: Effect.succeed({
            version: "0.0.0-test",
            bytes: bundleBytes,
            sha256: sha256(bundleBytes),
          }),
        },
        stateDir,
      }),
    );
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    try {
      const result = await Effect.runPromise(
        setupSpec
          .run({ installDir: "/opt/lando" })
          .pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, registry))),
      );

      expect(setupSpec.render?.(result)).toBe(
        'setup complete: Lando runtime (lando)\nLANDO_INSTALL_DIR="/opt/lando"',
      );
      expect(JSON.parse(await readFile(providerStatePath(stateDir), "utf8"))).toEqual({
        podmanVersion: "5.2.0",
        runtimeBundleVersion: "0.0.0-test",
        runtimeBundleSha256: sha256(bundleBytes),
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("compiled setup install dir", () => {
  test("matches source setup failure output and reports the same compiled install dir as shellenv", async () => {
    const build = await runCommand([process.execPath, "run", "build"]);
    expect(build.exitCode).toBe(0);

    const commandEnv = {
      PATH: "/no-such-path",
      LANDO_USER_CONF_ROOT: resolve(coreRoot, "dist/setup-test-conf"),
      LANDO_USER_DATA_ROOT: resolve(coreRoot, "dist/setup-test-data"),
    };
    const source = await runCommand([process.execPath, sourceCliPath, "setup"], coreRoot, commandEnv);
    const compiled = await runCommand([binaryPath, "setup"], coreRoot, commandEnv);
    const shellenv = await runCommand([binaryPath, "shellenv"]);

    expect(compiled.exitCode).toBe(source.exitCode);
    expect(compiled.stdout).toBe(source.stdout);
    expect(normalizeSetupFailure(compiled.stderr)).toBe(normalizeSetupFailure(source.stderr));
    expect(shellenv.stdout).toContain(`LANDO_INSTALL_DIR="${binaryDir}"`);
    expect(compiled.stderr).toContain(`LANDO_INSTALL_DIR="${dirname(binaryPath)}"`);
  }, 120_000);
});
