import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, type Context, Effect, Layer } from "effect";

import {
  CertificateAuthority,
  ConfigService,
  FileSyncEngine,
  HostProxyService,
  ProxyService,
  RuntimeProviderRegistry,
  SshService,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { manifest as providerLandoManifest } from "@lando/provider-lando";
import { makeRuntimeProvider, providerStatePath } from "@lando/provider-lando";
import { type AppPlan, type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import {
  TestFileSyncEngine,
  makeTestCertificateAuthority,
  makeTestProxyService,
  makeTestSshService,
} from "@lando/sdk/test";
import SetupCommand, {
  setupDeferredFileSyncPath,
  setupSpec,
  shouldDisableHostProxyForSetup,
} from "../../src/cli/oclif/commands/meta/setup.ts";
import { compiledCommandInputFromArgv } from "../../src/cli/run.ts";
import { HostProxyServiceDisabledLive } from "../../src/subsystems/host-proxy/api.ts";

const makeConfigService = (
  overrides: Partial<GlobalConfig> = {},
): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    ...overrides,
  };
  const load = Effect.succeed(config);
  return { load, get: (key) => Effect.map(load, (c) => c[key]) };
};

const buildSetupLayers = (
  registry: Context.Tag.Service<typeof RuntimeProviderRegistry>,
  configOverrides: Partial<GlobalConfig> = {},
): Layer.Layer<ConfigService | RuntimeProviderRegistry> =>
  Layer.merge(
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(ConfigService, makeConfigService(configOverrides)),
  );

const buildSetupLayersWithHostIntegrations = (
  registry: Context.Tag.Service<typeof RuntimeProviderRegistry>,
  services: {
    readonly ca: Context.Tag.Service<typeof CertificateAuthority>;
    readonly proxy: Context.Tag.Service<typeof ProxyService>;
    readonly ssh: Context.Tag.Service<typeof SshService>;
    readonly fileSync: Context.Tag.Service<typeof FileSyncEngine>;
  },
  configOverrides: Partial<GlobalConfig> = {},
): Layer.Layer<
  ConfigService | RuntimeProviderRegistry | CertificateAuthority | ProxyService | SshService | FileSyncEngine
> =>
  Layer.mergeAll(
    buildSetupLayers(registry, configOverrides),
    Layer.succeed(CertificateAuthority, services.ca),
    Layer.succeed(ProxyService, services.proxy),
    Layer.succeed(SshService, services.ssh),
    Layer.succeed(FileSyncEngine, services.fileSync),
  );

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

const fileSyncSatisfiedLine = "file-sync: already satisfied (native bind mounts)";

const setupCompleteOutput = (providerId: string, installDir = "/opt/lando"): string =>
  `setup complete: Lando runtime (${providerId})\n${fileSyncSatisfiedLine}\nLANDO_INSTALL_DIR="${installDir}"`;

describe("meta:setup command", () => {
  test("is registered at the minimal bootstrap level with the top-level setup alias", () => {
    expect(setupSpec.bootstrap).toBe("minimal");
    expect(SetupCommand.bootstrap).toBe("minimal");
    expect(SetupCommand.aliases).toContain("setup");
  });

  test("exposes provider-contributed setup.flags in metadata and compiled parsing", () => {
    expect(providerLandoManifest.contributes?.setup?.flags).toContainEqual({
      name: "runtime-bundle-url",
      description: "Override the Lando-managed runtime bundle URL for setup.",
      type: "option",
    });
    expect(Object.keys(SetupCommand.flags)).toContain("runtime-bundle-url");

    const input = compiledCommandInputFromArgv("meta:setup", [
      "--runtime-bundle-url",
      "https://example.invalid/lando-runtime.zip",
    ]);

    expect(input.flags["runtime-bundle-url"]).toBe("https://example.invalid/lando-runtime.zip");
  });

  test("passes runtime-bundle-url through to provider setup", async () => {
    const setupOptions: Array<{ readonly force: boolean; readonly runtimeBundleUrl?: string }> = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      setup: (options: { readonly force: boolean; readonly runtimeBundleUrl?: string }) =>
        Effect.sync(() => {
          setupOptions.push(options);
        }),
    };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    await Effect.runPromise(
      setupSpec
        .run({
          installDir: "/opt/lando",
          flags: { "runtime-bundle-url": "https://example.invalid/lando-runtime.zip" },
        })
        .pipe(Effect.provide(buildSetupLayers(registry))),
    );

    expect(setupOptions).toEqual([
      { force: false, runtimeBundleUrl: "https://example.invalid/lando-runtime.zip" },
    ]);
  });

  test("runs provider, CA, proxy, shell integration, and file sync in deterministic order", async () => {
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, bindMountPerformance: "slow" as const },
      setup: () =>
        Effect.sync(() => {
          calls.push("provider");
        }),
    };
    const ca = {
      ...makeTestCertificateAuthority(),
      setup: () =>
        Effect.sync(() => {
          calls.push("ca");
        }),
    };
    const proxy = {
      ...makeTestProxyService(),
      setup: () =>
        Effect.sync(() => {
          calls.push("proxy");
        }),
    };
    const ssh = {
      ...makeTestSshService(),
      setup: () =>
        Effect.sync(() => {
          calls.push("shell");
        }),
    };
    const fileSync = {
      ...TestFileSyncEngine,
      setup: () =>
        Effect.sync(() => {
          calls.push("file-sync");
        }),
    };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    await Effect.runPromise(
      setupSpec
        .run({ installDir: "/opt/lando" })
        .pipe(Effect.provide(buildSetupLayersWithHostIntegrations(registry, { ca, proxy, ssh, fileSync }))),
    );

    expect(calls).toEqual(["provider", "ca", "proxy", "shell", "file-sync"]);
  });

  test("reports file sync as already satisfied for native bind-mount providers", async () => {
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, bindMountPerformance: "native" as const },
      setup: () =>
        Effect.sync(() => {
          calls.push("provider");
        }),
    };
    const fileSync = {
      ...TestFileSyncEngine,
      setup: () => Effect.die("native bind-mount provider should not run file-sync setup"),
    };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    const result = await Effect.runPromise(
      setupSpec.run({ installDir: "/opt/lando" }).pipe(
        Effect.provide(
          buildSetupLayersWithHostIntegrations(registry, {
            ca: makeTestCertificateAuthority(),
            proxy: makeTestProxyService(),
            ssh: makeTestSshService(),
            fileSync,
          }),
        ),
      ),
    );

    expect(calls).toEqual(["provider"]);
    expect(setupSpec.render?.(result)).toContain(fileSyncSatisfiedLine);
  });

  test("--skip-file-sync records deferred setup for the first accelerated app:start", async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-setup-file-sync-deferred-"));
    try {
      const provider = {
        ...TestRuntimeProvider,
        id: "lando",
        capabilities: { ...TestRuntimeProvider.capabilities, bindMountPerformance: "slow" as const },
        setup: () => Effect.void,
      };
      const fileSync = {
        ...TestFileSyncEngine,
        setup: () => Effect.die("--skip-file-sync should not run file-sync setup"),
      };
      const registry = {
        list: Effect.succeed([ProviderId.make("lando")]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      };

      const result = await Effect.runPromise(
        setupSpec.run({ installDir: "/opt/lando", flags: { "skip-file-sync": true } }).pipe(
          Effect.provide(
            buildSetupLayersWithHostIntegrations(
              registry,
              {
                ca: makeTestCertificateAuthority(),
                proxy: makeTestProxyService(),
                ssh: makeTestSshService(),
                fileSync,
              },
              { userDataRoot },
            ),
          ),
        ),
      );

      const marker = JSON.parse(await readFile(setupDeferredFileSyncPath(userDataRoot), "utf-8")) as {
        readonly status: string;
        readonly engineId: string;
        readonly resumeCommand: string;
      };
      expect(marker).toEqual({
        status: "deferred",
        engineId: "mutagen",
        resumeCommand: "lando start",
      });
      expect(setupSpec.render?.(result)).toContain("file-sync: deferred until first accelerated app:start");
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  });

  test("honors setup skip flags for provider, CA trust install, proxy, shell, and file sync", async () => {
    const calls: string[] = [];
    const caSetupOptions: Array<{ readonly skipTrustInstall?: boolean }> = [];
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, bindMountPerformance: "slow" as const },
      setup: () =>
        Effect.sync(() => {
          calls.push("provider");
        }),
    };
    const ca = {
      ...makeTestCertificateAuthority(),
      setup: (opts: { readonly force: boolean; readonly skipTrustInstall?: boolean }) =>
        Effect.sync(() => {
          caSetupOptions.push(opts);
          calls.push("ca");
        }),
    };
    const proxy = {
      ...makeTestProxyService(),
      setup: () =>
        Effect.sync(() => {
          calls.push("proxy");
        }),
    };
    const ssh = {
      ...makeTestSshService(),
      setup: () =>
        Effect.sync(() => {
          calls.push("shell");
        }),
    };
    const fileSync = {
      ...TestFileSyncEngine,
      setup: () =>
        Effect.sync(() => {
          calls.push("file-sync");
        }),
    };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    await Effect.runPromise(
      setupSpec
        .run({
          installDir: "/opt/lando",
          flags: {
            "skip-provider": true,
            "skip-install-ca": true,
            "skip-proxy": true,
            "skip-shell-integration": true,
            "skip-file-sync": true,
          },
        })
        .pipe(Effect.provide(buildSetupLayersWithHostIntegrations(registry, { ca, proxy, ssh, fileSync }))),
    );

    expect(calls).toEqual(["ca"]);
    expect(caSetupOptions).toEqual([{ force: false, skipTrustInstall: true }]);
  });

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
      setupSpec.run({ installDir: "/opt/lando" }).pipe(Effect.provide(buildSetupLayers(registry))),
    );

    expect(setupCalls).toBe(1);
    expect(setupSpec.render?.(result)).toBe(setupCompleteOutput("lando"));
  });

  describe("system-runtime providers require an existing installation (US-200 AC5)", () => {
    for (const id of ["docker", "podman"] as const) {
      test(`--provider=${id} fails with remediation when the system runtime is unavailable`, async () => {
        let setupCalls = 0;
        const provider = {
          ...TestRuntimeProvider,
          id,
          isAvailable: Effect.succeed(false),
          setup: () =>
            Effect.sync(() => {
              setupCalls += 1;
            }),
        };
        const registry = {
          list: Effect.succeed([ProviderId.make("lando"), ProviderId.make(id)]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        };

        const exit = await Effect.runPromiseExit(
          setupSpec
            .run({ installDir: "/opt/lando", flags: { provider: id } })
            .pipe(Effect.provide(buildSetupLayers(registry))),
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag !== "Failure") throw new Error("expected failure");
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag !== "Some") throw new Error("expected a typed failure");
        const error = failure.value as {
          readonly _tag?: string;
          readonly providerId?: string;
          readonly remediation?: string;
        };
        expect(error._tag).toBe("ProviderUnavailableError");
        expect(error.providerId).toBe(id);
        expect(error.remediation ?? "").toContain(`lando setup --provider=${id}`);
        expect(setupCalls).toBe(0);
      });

      test(`--provider=${id} --skip-provider skips availability probing and provider setup`, async () => {
        let setupCalls = 0;
        const provider = {
          ...TestRuntimeProvider,
          id,
          isAvailable: Effect.die("availability probe should be skipped"),
          setup: () =>
            Effect.sync(() => {
              setupCalls += 1;
            }),
        };
        const registry = {
          list: Effect.succeed([ProviderId.make("lando"), ProviderId.make(id)]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        };

        const result = await Effect.runPromise(
          setupSpec
            .run({ installDir: "/opt/lando", flags: { provider: id, "skip-provider": true } })
            .pipe(Effect.provide(buildSetupLayers(registry))),
        );

        expect(setupCalls).toBe(0);
        expect(setupSpec.render?.(result)).toBe(setupCompleteOutput(id));
      });

      test(`--provider=${id} proceeds when the system runtime is available`, async () => {
        let setupCalls = 0;
        const provider = {
          ...TestRuntimeProvider,
          id,
          isAvailable: Effect.succeed(true),
          setup: () =>
            Effect.sync(() => {
              setupCalls += 1;
            }),
        };
        const registry = {
          list: Effect.succeed([ProviderId.make("lando"), ProviderId.make(id)]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        };

        const result = await Effect.runPromise(
          setupSpec
            .run({ installDir: "/opt/lando", flags: { provider: id } })
            .pipe(Effect.provide(buildSetupLayers(registry))),
        );

        expect(setupCalls).toBe(1);
        expect(setupSpec.render?.(result)).toBe(setupCompleteOutput(id));
      });
    }
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
        .pipe(Effect.provide(buildSetupLayers(registry))),
    );

    expect(selectedProvider).toBe("podman");
    expect(setupCalls).toBe(1);
    expect(setupSpec.render?.(result)).toBe(setupCompleteOutput("podman"));
  });

  test("host-proxy none remains honored when proxy setup is skipped", () => {
    expect(shouldDisableHostProxyForSetup({ flags: { "skip-proxy": true, "host-proxy": "none" } })).toBe(
      true,
    );
  });

  test("host-proxy none uses the disabled no-op layer", async () => {
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
        .run({ installDir: "/opt/lando", flags: { "host-proxy": "none" } })
        .pipe(Effect.provide(buildSetupLayers(registry))),
    );
    const status = await Effect.runPromise(
      Effect.gen(function* () {
        const hostProxy = yield* HostProxyService;
        yield* hostProxy.setup({ mode: "none" });
        return yield* hostProxy.status();
      }).pipe(Effect.provide(HostProxyServiceDisabledLive)),
    );

    expect(setupCalls).toBe(1);
    expect(setupSpec.render?.(result)).toBe(setupCompleteOutput("lando"));
    expect(status).toEqual({
      active: false,
      mode: "none",
      mechanism: "skipped",
      baseDomain: "lndo.site",
      loopback: "127.0.0.1",
    });
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
        setupSpec.run({ installDir: "/opt/lando" }).pipe(Effect.provide(buildSetupLayers(registry))),
      );

      expect(setupSpec.render?.(result)).toBe(setupCompleteOutput("lando"));
      expect(JSON.parse(await readFile(providerStatePath(stateDir), "utf8"))).toEqual({
        podmanVersion: "5.2.0",
        runtimeBundleVersion: "0.0.0-test",
        runtimeBundleSha256: sha256(bundleBytes),
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  describe("provider selection precedence", () => {
    const buildRegistryThatCapturesPlan = (provider: typeof TestRuntimeProvider) => {
      const observed: { providerId?: string } = {};
      const registry = {
        list: Effect.succeed([
          ProviderId.make("lando"),
          ProviderId.make("docker"),
          ProviderId.make("podman"),
        ]),
        capabilities: Effect.succeed(provider.capabilities),
        select: (plan?: AppPlan) => {
          observed.providerId = plan?.provider === undefined ? undefined : String(plan.provider);
          return Effect.succeed(provider);
        },
      };
      return { registry, observed };
    };

    test("LANDO_PROVIDER env var overrides config default", async () => {
      const previous = process.env.LANDO_PROVIDER;
      process.env.LANDO_PROVIDER = "podman";
      try {
        const provider = {
          ...TestRuntimeProvider,
          id: "podman",
          setup: () => Effect.void,
        };
        const { registry, observed } = buildRegistryThatCapturesPlan(provider);
        await Effect.runPromise(
          setupSpec.run({ installDir: "/opt/lando" }).pipe(Effect.provide(buildSetupLayers(registry))),
        );
        expect(observed.providerId).toBe("podman");
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
        else process.env.LANDO_PROVIDER = previous;
      }
    });

    test("--provider flag overrides LANDO_PROVIDER", async () => {
      const previous = process.env.LANDO_PROVIDER;
      process.env.LANDO_PROVIDER = "podman";
      try {
        const provider = {
          ...TestRuntimeProvider,
          id: "docker",
          setup: () => Effect.void,
        };
        const { registry, observed } = buildRegistryThatCapturesPlan(provider);
        await Effect.runPromise(
          setupSpec
            .run({ installDir: "/opt/lando", flags: { provider: "docker" } })
            .pipe(Effect.provide(buildSetupLayers(registry))),
        );
        expect(observed.providerId).toBe("docker");
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
        else process.env.LANDO_PROVIDER = previous;
      }
    });

    test("falls back to ~/.lando/config.yml defaultProviderId when neither flag nor env is set", async () => {
      const previous = process.env.LANDO_PROVIDER;
      Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
      try {
        const provider = {
          ...TestRuntimeProvider,
          id: "docker",
          setup: () => Effect.void,
        };
        const { registry, observed } = buildRegistryThatCapturesPlan(provider);
        await Effect.runPromise(
          setupSpec
            .run({ installDir: "/opt/lando" })
            .pipe(
              Effect.provide(buildSetupLayers(registry, { defaultProviderId: ProviderId.make("docker") })),
            ),
        );
        expect(observed.providerId).toBe("docker");
      } finally {
        if (previous !== undefined) process.env.LANDO_PROVIDER = previous;
      }
    });

    test("falls back to capability default `lando` when config has no defaultProviderId and no env/flag", async () => {
      const previous = process.env.LANDO_PROVIDER;
      Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
      try {
        const provider = {
          ...TestRuntimeProvider,
          id: "lando",
          setup: () => Effect.void,
        };
        const { registry, observed } = buildRegistryThatCapturesPlan(provider);
        await Effect.runPromise(
          setupSpec
            .run({ installDir: "/opt/lando" })
            .pipe(Effect.provide(buildSetupLayers(registry, { defaultProviderId: null }))),
        );
        expect(observed.providerId).toBe("lando");
      } finally {
        if (previous !== undefined) process.env.LANDO_PROVIDER = previous;
      }
    });
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
