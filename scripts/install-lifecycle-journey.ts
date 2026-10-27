#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectOwnedExecutable } from "@lando/engine/install/owned-executable";
import { isPathWithin, makeLandoPaths } from "@lando/paths";
import { Result } from "effect";
import { bounded, writeAcceptanceReport } from "./_acceptance-harness.ts";
import {
  LIFECYCLE_SIGNATURE_LIMITATION,
  prepareLifecycleDistribution,
} from "./install-lifecycle-journey-install.ts";
import {
  assertFreshWindowsLifecycleHost,
  assertLifecycleHostIsolation,
  assertLifecycleRuntimeIsolation,
  assertLifecycleWindowsMachineAbsent,
} from "./install-lifecycle-journey-preflight.ts";
import {
  LifecycleJourneyError,
  assertLifecycleRemoval,
  runLifecycle,
} from "./install-lifecycle-journey-runner.ts";

export type LifecycleOptions = {
  readonly binary: string;
  readonly workDir: string;
  readonly report: string;
  readonly provider: "lando" | "docker";
};

export const runInstallLifecycleJourney = async (options: LifecycleOptions) => {
  const workDir = resolve(options.workDir);
  const source = await realpath(options.binary);
  const checkout = await realpath(resolve(import.meta.dirname, ".."));
  if (isPathWithin(checkout, workDir)) {
    throw new LifecycleJourneyError("--work-dir must be outside the checkout.");
  }
  await mkdir(workDir, { mode: 0o700 });
  const canonicalWorkDir = await realpath(workDir);
  if (isPathWithin(checkout, canonicalWorkDir)) {
    throw new LifecycleJourneyError("--work-dir resolves inside the checkout.");
  }
  const paths = makeLandoPaths({
    userConfRoot: join(workDir, "conf"),
    userDataRoot: join(workDir, "data"),
    userCacheRoot: join(workDir, "cache"),
    systemPluginRoot: join(workDir, "system-plugins"),
    sources: { user: false, env: false },
  });
  const windows = process.platform === "win32";
  const installDir = join(workDir, "installed");
  const installed = join(installDir, windows ? "lando.exe" : "lando");
  const appDir = join(workDir, "app");
  const home = join(workDir, "home");
  await Promise.all([appDir, home, join(workDir, "xdg-run")].map((path) => mkdir(path, { mode: 0o700 })));
  const name = `lifecycle-${crypto.randomUUID().slice(0, 12)}`;
  await writeFile(
    join(appDir, ".lando.yml"),
    `name: ${name}\nruntime: 4\nprovider: ${options.provider}\nservices:\n  web:\n    type: compose\n    image: nginx:1.27-alpine\n    appMount: false\n`,
  );
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LANDO_"))),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    ...(windows ? { USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") } : {}),
    PATH: `${installDir}${delimiter}${process.env.PATH ?? ""}`,
    LANDO_USER_CONF_ROOT: paths.roots.userConfRoot,
    LANDO_USER_DATA_ROOT: paths.roots.userDataRoot,
    LANDO_USER_CACHE_ROOT: paths.roots.userCacheRoot,
    LANDO_SYSTEM_PLUGIN_ROOT: paths.roots.systemPluginRoot,
    LANDO_PROVIDER: options.provider,
    LANDO_RENDERER: "plain",
    LANDO_TELEMETRY: "0",
    ...(process.env.LANDO_RUNTIME_BUNDLE_MANIFEST
      ? { LANDO_RUNTIME_BUNDLE_MANIFEST: process.env.LANDO_RUNTIME_BUNDLE_MANIFEST }
      : {}),
    ...(!windows && options.provider === "lando"
      ? {
          XDG_RUNTIME_DIR: join(workDir, "xdg-run"),
          CONTAINERS_STORAGE_CONF: join(workDir, "storage.conf"),
        }
      : {}),
  };
  if (!windows && options.provider === "lando") {
    await writeFile(
      join(workDir, "storage.conf"),
      `[storage]\ndriver = "overlay"\n[storage.options.overlay]\nmount_program = ${JSON.stringify(join(paths.runtimeBinDir, "fuse-overlayfs"))}\n`,
    );
  }
  const commands: {
    readonly id: string;
    readonly argv: readonly string[];
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }[] = [];
  const command = async (id: string, argv: readonly string[], overrides: NodeJS.ProcessEnv = {}) => {
    const proc = Bun.spawn({
      cmd: [...argv],
      cwd: appDir,
      env: { ...env, ...overrides },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20 * 60 * 1000,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    commands.push({ id, argv, exitCode, stdout: bounded(stdout), stderr: bounded(stderr) });
    if (exitCode !== 0) throw new LifecycleJourneyError(`${id} exited ${exitCode}: ${bounded(stderr)}`);
    return stdout;
  };
  const result = await runLifecycle({
    preflight: async () => {
      if (process.arch !== "x64" || (process.platform !== "linux" && !windows)) {
        throw new LifecycleJourneyError("This journey supports Linux x64 and Windows x64 only.");
      }
      if (process.env.LANDO_LIFECYCLE_FRESH_RUNNER !== "1") {
        throw new LifecycleJourneyError(
          "Set LANDO_LIFECYCLE_FRESH_RUNNER=1 only on a dedicated fresh host/runtime. Purge can sweep host-global Lando resources despite isolated roots.",
        );
      }
      assertLifecycleHostIsolation(
        await command("uninstall-safety-preflight", [
          source,
          "uninstall",
          "--dry-run",
          "--purge",
          "--format=json",
        ]),
      );
      for (const runtime of ["docker", "podman"]) {
        if (Bun.which(runtime, { PATH: env.PATH })) await assertLifecycleRuntimeIsolation(runtime, command);
      }
      if (windows) await assertFreshWindowsLifecycleHost(options.provider, command);
    },
    install: async () => {
      const distribution = await prepareLifecycleDistribution(source, workDir);
      await command("installer", distribution.argv, { ...distribution.env, LANDO_INSTALL_DIR: installDir });
      const ownership = inspectOwnedExecutable({
        recordFile: paths.installRecordFile,
        platform: process.platform,
        destination: installed,
      });
      if (Result.isFailure(ownership)) throw new LifecycleJourneyError(ownership.failure.message);
      if (ownership.success.sha256 !== distribution.sha256)
        throw new LifecycleJourneyError("Installed digest differs from compiled payload.");
    },
    setup: async () => {
      await command("setup", [
        installed,
        "setup",
        "--yes",
        "--no-interactive",
        `--provider=${options.provider}`,
        "--skip-proxy",
        "--skip-install-ca",
        "--skip-shell-integration",
        "--skip-file-sync",
      ]);
    },
    start: async () => {
      await command("start", [installed, "start"]);
    },
    functional: async () => {
      const body = await command("http-in-container", [
        installed,
        "exec",
        "web",
        "--",
        "wget",
        "-qO-",
        "http://127.0.0.1",
      ]);
      if (!body.includes("Welcome to nginx!"))
        throw new LifecycleJourneyError("Running nginx did not serve its expected HTTP page.");
    },
    destroy: async () => {
      await command("destroy", [installed, "destroy", "--yes"]);
    },
    uninstall: async () => {
      if (!existsSync(installed))
        throw new LifecycleJourneyError("Installer did not publish the executable; uninstall could not run.");
      await command("uninstall", [installed, "uninstall", "--yes", "--purge"]);
    },
    removal: async () => {
      await assertLifecycleRemoval(
        [installed, paths.installRecordFile, paths.runtimeDir],
        windows ? 30_000 : 0,
      );
      if (windows)
        assertLifecycleWindowsMachineAbsent(
          await command("windows-machine-removal", ["wsl.exe", "--list", "--quiet"]),
        );
    },
  });
  const report = {
    schemaVersion: 1,
    id: "install-lifecycle-journey",
    platform: process.platform,
    provider: options.provider,
    appName: name,
    workDir,
    source,
    installed,
    signatureTrust: LIFECYCLE_SIGNATURE_LIMITATION,
    ...result,
    commands,
  };
  await writeAcceptanceReport(options.report, report, result.classification);
  return report;
};

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      binary: { type: "string" },
      "work-dir": { type: "string" },
      report: { type: "string" },
      provider: { type: "string", default: "lando" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      `Usage: bun scripts/install-lifecycle-journey.ts --binary <compiled-path> --work-dir <fresh-external-directory> --report <path> [--provider=lando|docker]\nRequires LANDO_LIFECYCLE_FRESH_RUNNER=1 on a dedicated fresh host/runtime; preflight rejects existing host-global Lando integration and resources.\n${LIFECYCLE_SIGNATURE_LIMITATION}`,
    );
  } else {
    if (
      !values.binary ||
      !values["work-dir"] ||
      !values.report ||
      (values.provider !== "lando" && values.provider !== "docker")
    ) {
      throw new LifecycleJourneyError(
        "Require --binary, --work-dir, --report, and --provider=lando|docker; see --help.",
      );
    }
    await runInstallLifecycleJourney({
      binary: resolve(values.binary),
      workDir: resolve(values["work-dir"]),
      report: resolve(values.report),
      provider: values.provider,
    });
  }
}
