import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import {
  CGROUPS_DELEGATE_CONF_CONTENT,
  LANDO_SHELLENV_BEGIN,
  LANDO_SHELLENV_END,
  type RemoveRuntimeDirDeps,
  UninstallRuntimeDirError,
  buildUninstallPlan,
  chmodTreeUserWritable,
  defaultPosixShellProfilePath,
  defaultRemoveRuntimeDir,
  formatUninstallRuntimeDirStepError,
  leftoverUninstallRuntimeDirError,
  managedPodmanUnshareRmInvocation,
  stripLandoShellenvBlock,
  uninstall,
  uninstallRuntimeDirRemediation,
} from "../../src/operations/uninstall.ts";
import {
  makeUninstallRoots,
  managedVolumeDataFile,
  sandboxUninstallOptions,
  writeFakeManagedPodman,
  writeManagedVolumeTree,
} from "./uninstall-support.ts";

const removeRuntimeDir = defaultRemoveRuntimeDir;

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

const writeOverlayDiffTree = (runtimeDir: string): string => {
  const diffDir = join(runtimeDir, "storage", "overlay", "l", "abc123", "diff");
  mkdirSync(diffDir, { recursive: true });
  const blob = join(diffDir, "opaque");
  writeFileSync(blob, "overlay-blob");
  chmodSync(blob, 0o444);
  chmodSync(diffDir, 0o555);
  return diffDir;
};

describe("uninstall runtime overlay removal", () => {
  test("purge deletes overlay-like 555 diff dirs without a custom remove", async () => {
    const roots = makeUninstallRoots("lando-uninstall-overlay-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      mkdirSync(roots.userCacheRoot, { recursive: true });
      const runtimeDir = join(roots.userDataRoot, "runtime");
      writeOverlayDiffTree(runtimeDir);

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            purge: true,
            listDiscoveredApps: async () => [],
          }),
        ),
      );

      expect(existsSync(runtimeDir)).toBe(false);
      expect(result.failed).toBe(false);
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "completed",
      });
    } finally {
      await chmodTreeUserWritable(roots.root);
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("managed unshare fallback invokes runtimeDir/bin/podman, never PATH podman", () => {
    const runtimeDir = "/tmp/lando-isolated-runtime";
    const invocation = managedPodmanUnshareRmInvocation(runtimeDir);
    expect(invocation.command).toBe(join(runtimeDir, "bin", "podman"));
    expect(invocation.command).not.toBe("podman");
    expect(invocation.args).toEqual(["unshare", "rm", "-rf", runtimeDir]);
  });

  test("defaultRemoveRuntimeDir invokes the managed podman unshare binary when present", async () => {
    const roots = makeUninstallRoots("lando-uninstall-unshare-");
    const previousPath = process.env.PATH;
    try {
      const runtimeDir = join(roots.userDataRoot, "runtime");
      const binDir = join(runtimeDir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeOverlayDiffTree(runtimeDir);

      const managedLog = join(roots.root, "managed-podman.log");
      const decoyDir = join(roots.root, "decoy-bin");
      mkdirSync(decoyDir, { recursive: true });
      const decoyLog = join(roots.root, "decoy-podman.log");
      writeFileSync(
        join(binDir, "podman"),
        ["#!/bin/sh", `printf '%s\\n' "$0 $*" >> "${managedLog}"`, "exit 0", ""].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(
        join(decoyDir, "podman"),
        ["#!/bin/sh", `printf '%s\\n' "$0 $*" >> "${decoyLog}"`, "exit 0", ""].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = decoyDir;

      await defaultRemoveRuntimeDir(runtimeDir);

      expect(existsSync(runtimeDir)).toBe(false);
      const managed = existsSync(managedLog) ? readFileSync(managedLog, "utf8") : "";
      expect(managed).toContain(join(binDir, "podman"));
      const storageUnshare = `unshare rm -rf ${join(runtimeDir, "storage")}`;
      const runtimeUnshare = `unshare rm -rf ${runtimeDir}`;
      expect(managed).toContain(storageUnshare);
      const storageIdx = managed.indexOf(storageUnshare);
      expect(managed.slice(storageIdx + storageUnshare.length)).toContain(runtimeUnshare);
      expect(existsSync(decoyLog)).toBe(false);
    } finally {
      if (previousPath === undefined) Reflect.deleteProperty(process.env, "PATH");
      else process.env.PATH = previousPath;
      await chmodTreeUserWritable(roots.root);
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("uninstall SIGTERMs a runtime/bin process without requiring system service argv", async () => {
    const roots = makeUninstallRoots("lando-uninstall-sleeper-");
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      mkdirSync(roots.userCacheRoot, { recursive: true });
      const runtimeDir = join(roots.userDataRoot, "runtime");
      const binDir = join(runtimeDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const sleeper = join(binDir, "sleeper");
      const sleepBin = existsSync("/bin/sleep") ? "/bin/sleep" : "/usr/bin/sleep";
      copyFileSync(sleepBin, sleeper);
      chmodSync(sleeper, 0o755);
      child = Bun.spawn([sleeper, "60"], { stdout: "ignore", stderr: "ignore" });
      const pid = child.pid;
      expect(pid).toBeGreaterThan(1);
      expect(() => process.kill(pid, 0)).not.toThrow();

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            keepData: true,
          }),
        ),
      );

      expect(result.failed).toBe(false);
      expect(existsSync(runtimeDir)).toBe(false);
      await Bun.sleep(100);
      expect(pidIsGone(pid)).toBe(true);
    } finally {
      if (child !== undefined) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already reaped by SIGTERM.
        }
      }
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("runtime leftovers after the removal attempt fail closed", async () => {
    const roots = makeUninstallRoots("lando-uninstall-leftover-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      const runtimeDir = join(roots.userDataRoot, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(join(runtimeDir, "held"), "still-here");

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            keepData: true,
            remove: async () => {
              // Pretend success while leaving the runtime tree in place.
            },
          }),
        ),
      );

      expect(existsSync(runtimeDir)).toBe(true);
      expect(result.failed).toBe(true);
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "failed",
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });
});

describe("uninstall managed volume purge", () => {
  test("purge deletes managed volume data without a custom remove", async () => {
    const roots = makeUninstallRoots("lando-uninstall-volume-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      mkdirSync(roots.userCacheRoot, { recursive: true });
      const runtimeDir = join(roots.userDataRoot, "runtime");
      const volumeFile = managedVolumeDataFile(runtimeDir);
      writeManagedVolumeTree(runtimeDir);
      writeFakeManagedPodman(join(runtimeDir, "bin"), ["#!/bin/sh", 'rm -rf "$4"', "exit 0", ""].join("\n"));

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            purge: true,
            listDiscoveredApps: async () => [],
          }),
        ),
      );

      expect(existsSync(volumeFile)).toBe(false);
      expect(existsSync(runtimeDir)).toBe(false);
      expect(result.failed).toBe(false);
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "completed",
      });
    } finally {
      await chmodTreeUserWritable(roots.root);
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("defaultRemoveRuntimeDir unshares storage before the runtime tree", async () => {
    const roots = makeUninstallRoots("lando-uninstall-volume-order-");
    try {
      const runtimeDir = join(roots.userDataRoot, "runtime");
      const storageDir = join(runtimeDir, "storage");
      const volumeFile = managedVolumeDataFile(runtimeDir);
      writeManagedVolumeTree(runtimeDir);
      writeFakeManagedPodman(
        join(runtimeDir, "bin"),
        [
          "#!/bin/sh",
          `if [ "$4" = "${storageDir}" ]; then rm -rf "$4"; exit 0; fi`,
          `rm -f "${join(runtimeDir, "bin", "podman")}"`,
          "exit 1",
          "",
        ].join("\n"),
      );

      await removeRuntimeDir(runtimeDir, {
        removeTree: async (path) => {
          if (existsSync(volumeFile)) {
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          }
          await rm(path, { recursive: true, force: true });
        },
      });

      expect(existsSync(volumeFile)).toBe(false);
    } finally {
      await chmodTreeUserWritable(roots.root);
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("defaultRemoveRuntimeDir leftover is UninstallRuntimeDirError for a held volume", async () => {
    const roots = makeUninstallRoots("lando-uninstall-volume-s2-direct-");
    try {
      const runtimeDir = join(roots.userDataRoot, "runtime");
      const volumeFile = managedVolumeDataFile(runtimeDir);
      writeManagedVolumeTree(runtimeDir);
      writeFakeManagedPodman(join(runtimeDir, "bin"), "#!/bin/sh\nexit 1\n");
      const heldVolume: RemoveRuntimeDirDeps = {
        unshareRm: async () => {
          throw new Error("unshare failed");
        },
        removeTree: async () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      };

      const act = removeRuntimeDir(runtimeDir, heldVolume);
      await expect(act).rejects.toBeInstanceOf(UninstallRuntimeDirError);
      await expect(act).rejects.toMatchObject({
        _tag: "UninstallRuntimeDirError",
        path: volumeFile,
        remediation: uninstallRuntimeDirRemediation(volumeFile, true, join(runtimeDir, "bin", "podman")),
      });
    } finally {
      await chmodTreeUserWritable(roots.root);
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("purge leftover volume fails runtime-service with UninstallRuntimeDirError", async () => {
    const roots = makeUninstallRoots("lando-uninstall-volume-s2-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      mkdirSync(roots.userCacheRoot, { recursive: true });
      const runtimeDir = join(roots.userDataRoot, "runtime");
      const volumeFile = managedVolumeDataFile(runtimeDir);
      writeManagedVolumeTree(runtimeDir);
      writeFakeManagedPodman(join(runtimeDir, "bin"), "#!/bin/sh\nexit 1\n");
      const heldVolume: RemoveRuntimeDirDeps = {
        unshareRm: async () => {
          throw new Error("unshare failed");
        },
        removeTree: async () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      };

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            purge: true,
            listDiscoveredApps: async () => [],
            remove: (path) => removeRuntimeDir(path, heldVolume),
          }),
        ),
      );

      expect(result.failed).toBe(true);
      const step = result.steps.find((entry) => entry.id === "runtime-service");
      expect(step).toMatchObject({ outcome: "failed" });
      const formatted = formatUninstallRuntimeDirStepError(
        leftoverUninstallRuntimeDirError(runtimeDir, existsSync),
      );
      const error = step?.error ?? "";
      expect(
        error === formatted ||
          (error.includes(volumeFile) && error.includes("lando uninstall --purge --yes")),
      ).toBe(true);
    } finally {
      await chmodTreeUserWritable(roots.root);
      rmSync(roots.root, { recursive: true, force: true });
    }
  });
});

describe("uninstall managed provider runtime path", () => {
  test("targets providers/provider-lando and does not skip when providers/lando is absent", async () => {
    const roots = makeUninstallRoots("lando-uninstall-provider-path-");
    try {
      const bundle = join(roots.userDataRoot, "providers", "provider-lando");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "runtime-bundle.json"), "{}");

      const plan = await buildUninstallPlan(
        sandboxUninstallOptions(roots, {
          exists: (path: string) => path === bundle,
        }),
        "keep-data",
      );

      expect(plan.find((step) => step.id === "managed-provider-runtime")).toMatchObject({
        target: bundle,
        status: "owned",
      });
      expect(plan.find((step) => step.id === "managed-provider-runtime")?.target).toBe(
        join(roots.userDataRoot, "providers", "provider-lando"),
      );
      expect(plan.find((step) => step.id === "managed-provider-runtime")?.target).not.toBe(
        join(roots.userDataRoot, "providers", "lando"),
      );
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });
});

describe("uninstall cgroups delegation drop-in", () => {
  test("matching delegate.conf is owned and removed", async () => {
    const roots = makeUninstallRoots("lando-uninstall-delegate-match-");
    try {
      writeFileSync(roots.cgroupsDelegatePath, CGROUPS_DELEGATE_CONF_CONTENT);

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            keepData: true,
          }),
        ),
      );

      expect(result.failed).toBe(false);
      expect(existsSync(roots.cgroupsDelegatePath)).toBe(false);
      expect(result.steps.find((step) => step.id === "cgroups-delegate")).toMatchObject({
        status: "owned",
        outcome: "completed",
        target: roots.cgroupsDelegatePath,
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("echo-written delegate.conf is owned and removed", async () => {
    const roots = makeUninstallRoots("lando-uninstall-delegate-echo-");
    try {
      const echoed = spawnSync("/bin/sh", ["-c", `echo '${CGROUPS_DELEGATE_CONF_CONTENT}'`], {
        encoding: "buffer",
      });
      expect(echoed.status).toBe(0);
      const echoWritten = echoed.stdout;
      expect(echoWritten.toString("utf8")).not.toBe(CGROUPS_DELEGATE_CONF_CONTENT);
      writeFileSync(roots.cgroupsDelegatePath, echoWritten);

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            keepData: true,
          }),
        ),
      );

      expect(result.failed).toBe(false);
      expect(existsSync(roots.cgroupsDelegatePath)).toBe(false);
      expect(result.steps.find((step) => step.id === "cgroups-delegate")).toMatchObject({
        status: "owned",
        outcome: "completed",
        target: roots.cgroupsDelegatePath,
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("owned drop-in unlink EACCES fails the step", async () => {
    const roots = makeUninstallRoots("lando-uninstall-delegate-eacces-");
    try {
      const echoed = spawnSync("/bin/sh", ["-c", `echo '${CGROUPS_DELEGATE_CONF_CONTENT}'`], {
        encoding: "buffer",
      });
      expect(echoed.status).toBe(0);
      writeFileSync(roots.cgroupsDelegatePath, echoed.stdout);

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            keepData: true,
            remove: async (path: string) => {
              if (path === roots.cgroupsDelegatePath) {
                const error = new Error(
                  `EACCES: permission denied, unlink '${path}'`,
                ) as NodeJS.ErrnoException;
                error.code = "EACCES";
                throw error;
              }
              rmSync(path, { recursive: true, force: true });
            },
          }),
        ),
      );

      expect(result.failed).toBe(true);
      expect(existsSync(roots.cgroupsDelegatePath)).toBe(true);
      const step = result.steps.find((entry) => entry.id === "cgroups-delegate");
      expect(step).toMatchObject({
        status: "owned",
        outcome: "failed",
      });
      expect(step?.error).toMatch(/EACCES/u);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("different delegate.conf content is not deleted", async () => {
    const roots = makeUninstallRoots("lando-uninstall-delegate-other-");
    try {
      writeFileSync(roots.cgroupsDelegatePath, "[Service]\nDelegate=cpu\n");

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            keepData: true,
          }),
        ),
      );

      expect(existsSync(roots.cgroupsDelegatePath)).toBe(true);
      expect(result.steps.find((step) => step.id === "cgroups-delegate")).toMatchObject({
        status: "user-owned",
        outcome: "manual",
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("missing delegate.conf is skipped", async () => {
    const roots = makeUninstallRoots("lando-uninstall-delegate-missing-");
    try {
      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            keepData: true,
          }),
        ),
      );

      expect(result.steps.find((step) => step.id === "cgroups-delegate")).toMatchObject({
        status: "skipped",
        outcome: "skipped",
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });
});

describe("uninstall shellenv profile strip", () => {
  test("purge strips the delimited block and keeps user lines", async () => {
    const roots = makeUninstallRoots("lando-uninstall-shellenv-purge-");
    try {
      writeFileSync(
        roots.shellProfilePath,
        [
          "export USER_LINE=keep-me",
          LANDO_SHELLENV_BEGIN,
          "export LANDO_USER_DATA_ROOT='/tmp/lando'",
          'export PATH="${LANDO_USER_DATA_ROOT}/bin:${PATH}"',
          LANDO_SHELLENV_END,
          "export AFTER=still-here",
          "",
        ].join("\n"),
      );

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            purge: true,
            listDiscoveredApps: async () => [],
          }),
        ),
      );

      expect(result.failed).toBe(false);
      const rewritten = readFileSync(roots.shellProfilePath, "utf8");
      expect(rewritten).toContain("export USER_LINE=keep-me");
      expect(rewritten).toContain("export AFTER=still-here");
      expect(rewritten).not.toContain(LANDO_SHELLENV_BEGIN);
      expect(rewritten).not.toContain(LANDO_SHELLENV_END);
      expect(rewritten).not.toContain("LANDO_USER_DATA_ROOT");
      expect(result.steps.find((step) => step.id === "shell-entries")).toMatchObject({
        status: "owned",
        outcome: "completed",
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("keep-data leaves the shellenv block in the profile", async () => {
    const roots = makeUninstallRoots("lando-uninstall-shellenv-keep-");
    try {
      const original = [
        "export USER_LINE=keep-me",
        LANDO_SHELLENV_BEGIN,
        "export LANDO_USER_DATA_ROOT='/tmp/lando'",
        LANDO_SHELLENV_END,
        "",
      ].join("\n");
      writeFileSync(roots.shellProfilePath, original);

      const result = await Effect.runPromise(
        uninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            keepData: true,
          }),
        ),
      );

      expect(readFileSync(roots.shellProfilePath, "utf8")).toBe(original);
      expect(result.steps.find((step) => step.id === "shell-entries")).toMatchObject({
        status: "manual",
        outcome: "manual",
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("defaultPosixShellProfilePath prefers LANDO_SHELL_PROFILE when set", () => {
    expect(
      defaultPosixShellProfilePath({
        LANDO_SHELL_PROFILE: "/tmp/custom.rc",
        HOME: "/home/me",
        SHELL: "/bin/bash",
      }),
    ).toBe("/tmp/custom.rc");
  });

  test("defaultPosixShellProfilePath falls back to the shell-specific default profile", () => {
    expect(defaultPosixShellProfilePath({ HOME: "/home/me", SHELL: "/bin/zsh" })).toBe("/home/me/.zshrc");
    expect(defaultPosixShellProfilePath({ HOME: "/home/me", SHELL: "/bin/bash" })).toBe("/home/me/.bashrc");
    expect(defaultPosixShellProfilePath({ HOME: "/home/me" })).toBe("/home/me/.profile");
  });

  test("purge strips LANDO_SHELL_PROFILE when that env is set", async () => {
    const roots = makeUninstallRoots("lando-uninstall-shellenv-env-");
    const sandboxHome = join(roots.root, "home");
    const customProfile = join(roots.root, "custom.rc");
    mkdirSync(sandboxHome, { recursive: true });
    const original = [
      "export USER_LINE=keep-me",
      LANDO_SHELLENV_BEGIN,
      "export LANDO_USER_DATA_ROOT='/tmp/lando'",
      LANDO_SHELLENV_END,
      "export AFTER=still-here",
      "",
    ].join("\n");
    writeFileSync(customProfile, original);
    writeFileSync(join(sandboxHome, ".bashrc"), original);

    const previousProfile = process.env.LANDO_SHELL_PROFILE;
    const previousHome = process.env.HOME;
    const previousShell = process.env.SHELL;
    try {
      process.env.LANDO_SHELL_PROFILE = customProfile;
      process.env.HOME = sandboxHome;
      process.env.SHELL = "/bin/bash";

      const result = await Effect.runPromise(
        uninstall({
          userDataRoot: roots.userDataRoot,
          userCacheRoot: roots.userCacheRoot,
          execPath: roots.execPath,
          cgroupsDelegatePath: roots.cgroupsDelegatePath,
          yes: true,
          purge: true,
          listDiscoveredApps: async () => [],
        }),
      );

      expect(result.failed).toBe(false);
      const rewritten = readFileSync(customProfile, "utf8");
      expect(rewritten).toContain("export USER_LINE=keep-me");
      expect(rewritten).toContain("export AFTER=still-here");
      expect(rewritten).not.toContain(LANDO_SHELLENV_BEGIN);
      expect(readFileSync(join(sandboxHome, ".bashrc"), "utf8")).toBe(original);
      expect(result.steps.find((step) => step.id === "shell-entries")).toMatchObject({
        status: "owned",
        outcome: "completed",
        target: customProfile,
      });
    } finally {
      restoreEnv("LANDO_SHELL_PROFILE", previousProfile);
      restoreEnv("HOME", previousHome);
      restoreEnv("SHELL", previousShell);
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("purge still strips the default POSIX profile when LANDO_SHELL_PROFILE is unset", async () => {
    const roots = makeUninstallRoots("lando-uninstall-shellenv-default-");
    const sandboxHome = join(roots.root, "home");
    const defaultProfile = join(sandboxHome, ".bashrc");
    mkdirSync(sandboxHome, { recursive: true });
    writeFileSync(
      defaultProfile,
      [
        "export USER_LINE=keep-me",
        LANDO_SHELLENV_BEGIN,
        "export LANDO_USER_DATA_ROOT='/tmp/lando'",
        LANDO_SHELLENV_END,
        "",
      ].join("\n"),
    );

    const previousProfile = process.env.LANDO_SHELL_PROFILE;
    const previousHome = process.env.HOME;
    const previousShell = process.env.SHELL;
    try {
      Reflect.deleteProperty(process.env, "LANDO_SHELL_PROFILE");
      process.env.HOME = sandboxHome;
      process.env.SHELL = "/bin/bash";

      const result = await Effect.runPromise(
        uninstall({
          userDataRoot: roots.userDataRoot,
          userCacheRoot: roots.userCacheRoot,
          execPath: roots.execPath,
          cgroupsDelegatePath: roots.cgroupsDelegatePath,
          yes: true,
          purge: true,
          listDiscoveredApps: async () => [],
        }),
      );

      expect(result.failed).toBe(false);
      expect(readFileSync(defaultProfile, "utf8")).not.toContain(LANDO_SHELLENV_BEGIN);
      expect(result.steps.find((step) => step.id === "shell-entries")).toMatchObject({
        status: "owned",
        outcome: "completed",
        target: defaultProfile,
      });
    } finally {
      restoreEnv("LANDO_SHELL_PROFILE", previousProfile);
      restoreEnv("HOME", previousHome);
      restoreEnv("SHELL", previousShell);
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("stripLandoShellenvBlock is a no-op when the delimiters are absent", () => {
    expect(stripLandoShellenvBlock("export FOO=1\n")).toEqual({
      content: "export FOO=1\n",
      stripped: false,
    });
  });

  test("stripLandoShellenvBlock is a no-op when BEGIN has no matching END", () => {
    const content = `${LANDO_SHELLENV_BEGIN}\nexport FOO=1\n`;
    expect(stripLandoShellenvBlock(content)).toEqual({
      content,
      stripped: false,
    });
  });
});

const pidIsGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
