import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";

import { beforeAll, describe, expect, test } from "bun:test";
import { installRecordOwnsDestination } from "@lando/engine/install/record";
import { makeLandoPaths } from "@lando/paths";

import {
  defaultPosixShellProfilePath,
  defaultShellenvShell,
  renderPosixShellenv,
  renderPowerShellShellenv,
  renderShellenv,
  shellProfileInstallCommand,
  shellenvBinDir,
  shellenvCurrentExecutablePath,
} from "../../src/cli/commands/shellenv.ts";

const coreRoot = resolve(import.meta.dirname, "../..");
const binaryPath = resolve(coreRoot, "dist/lando");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (
  cmd: Array<string>,
  cwd = coreRoot,
  env: NodeJS.ProcessEnv = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: {
      ...process.env,
      ...env,
    },
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

describe.skipIf(!["linux", "win32"].includes(process.platform) || process.arch !== "x64")(
  "compiled CLI shellenv command",
  () => {
    beforeAll(async () => {
      const build = await runCommand([process.execPath, "run", "build"]);
      expect(build.exitCode).toBe(0);
    }, 120_000);

    for (const shellArgs of [[], ["--shell=posix"], ["--shell=powershell"]]) {
      test(`integrates a relocated manual executable through ${shellArgs[0] ?? "the fast path"}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "lando-manual-shellenv-"));
        try {
          const executableDir = join(root, "manual ' [bin]");
          const dataRoot = join(root, "data");
          const paths = makeLandoPaths({ userDataRoot: dataRoot });
          const relocated = join(executableDir, process.platform === "win32" ? "lando.exe" : "lando");
          await mkdir(executableDir);
          await copyFile(binaryPath, relocated);
          const env = {
            LANDO_USER_DATA_ROOT: dataRoot,
            LANDO_USER_CACHE_ROOT: join(root, "cache"),
            LANDO_USER_CONF_ROOT: join(root, "conf"),
          };
          const result = await runCommand([relocated, "shellenv", ...shellArgs], root, env);
          const shell = shellArgs[0]?.endsWith("powershell")
            ? "powershell"
            : shellArgs.length === 0
              ? defaultShellenvShell()
              : "posix";

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe("");
          expect(result.stdout.trim()).toBe(renderShellenv(shell, dataRoot, relocated));
          expect(result.stdout).not.toContain(paths.binDir);
          expect(await Bun.file(paths.installRecordFile).exists()).toBe(false);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 120_000);
    }
  },
);

describe("shellenv executable detection", () => {
  test("uses only compiled executable paths, including Windows virtual entries", () => {
    const windowsExe = String.raw`C:\Users\Lando\Programs\Lando\lando.exe`;
    const posixExe = "/opt/lando/bin/lando";
    expect(
      shellenvCurrentExecutablePath(posixExe, [posixExe, "/$bunfs/root/lando.ts"], { standalone: undefined }),
    ).toBe(posixExe);
    expect(
      shellenvCurrentExecutablePath(windowsExe, [windowsExe, String.raw`B:\~BUN\root\lando.ts`], {
        standalone: undefined,
      }),
    ).toBe(windowsExe);
    expect(
      shellenvCurrentExecutablePath(windowsExe, [windowsExe, "B:/~BUN/root/lando.ts"], {
        standalone: undefined,
      }),
    ).toBe(windowsExe);
    expect(shellenvCurrentExecutablePath(windowsExe, [windowsExe, "shellenv"], { standalone: true })).toBe(
      windowsExe,
    );
    expect(
      shellenvCurrentExecutablePath("/usr/bin/bun", ["/usr/bin/bun", "core/bin/lando.ts"], {
        standalone: false,
      }),
    ).toBeUndefined();
    expect(
      shellenvCurrentExecutablePath("/usr/bin/bun", ["/usr/bin/bun", "/$bunfs/root/lando.ts"], {
        standalone: false,
      }),
    ).toBeUndefined();
  });

  for (const executable of [
    "/opt/Lando User's/bin/lando",
    String.raw`C:\Users\Lando User's\Programs\Lando\lando.exe`,
    String.raw`\\host\share\Lando\lando.exe`,
  ]) {
    test(`renders manual executable directory without adopting ownership: ${executable}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "lando-shellenv-manual-"));
      try {
        const paths = makeLandoPaths({ userDataRoot: root });
        const expectedDir = executable.includes("\\") ? win32.dirname(executable) : dirname(executable);
        expect(shellenvBinDir(root, executable)).toBe(expectedDir);
        expect(renderPosixShellenv(root, executable)).not.toContain(paths.binDir);
        expect(renderPowerShellShellenv(root, executable)).toContain(expectedDir.replaceAll("'", "''"));
        expect(await Bun.file(paths.installRecordFile).exists()).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  for (const shellArgs of [[], ["--shell=posix"], ["--shell=powershell"]]) {
    test(`source dispatch retains data-root bin through ${shellArgs[0] ?? "the fast path"}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "lando-source-shellenv-"));
      try {
        const paths = makeLandoPaths({ userDataRoot: root });
        const result = await runCommand(
          [process.execPath, resolve(coreRoot, "bin/lando.ts"), "shellenv", ...shellArgs],
          root,
          {
            LANDO_USER_DATA_ROOT: root,
            LANDO_USER_CACHE_ROOT: join(root, "cache"),
            LANDO_USER_CONF_ROOT: join(root, "conf"),
          },
        );
        const shell = shellArgs[0]?.endsWith("powershell")
          ? "powershell"
          : shellArgs.length === 0
            ? defaultShellenvShell()
            : "posix";
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(renderShellenv(shell, root));
        expect(result.stdout).toContain(paths.binDir);
        expect(await Bun.file(paths.installRecordFile).exists()).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe("shellenv default shell", () => {
  test("uses PowerShell on native Windows and POSIX in a Windows POSIX shell", () => {
    expect(defaultShellenvShell("win32", {})).toBe("powershell");
    expect(defaultShellenvShell("win32", { SHELL: "/usr/bin/bash" })).toBe("posix");
    expect(defaultShellenvShell("win32", { SHELL: "/usr/bin/fish" })).toBe("powershell");
    expect(defaultShellenvShell("win32", { SHELL: "powershell.exe", MSYSTEM: "MINGW64" })).toBe("posix");
    expect(defaultShellenvShell("win32", { SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" })).toBe("posix");
    expect(defaultShellenvShell("linux", {})).toBe("posix");
    expect(defaultShellenvShell("darwin", {})).toBe("posix");
  });
});

describe("shellenv snippet rendering", () => {
  const gitBash =
    process.platform === "win32"
      ? "C:/Program Files/Git/bin/bash.exe"
      : "/mnt/c/Program Files/Git/bin/bash.exe";
  test.skipIf(!existsSync(gitBash))(
    "MSYS converts native Windows bin paths once and retains native data-root values",
    async () => {
      const nativeRoot = String.raw`C:\Lando User's\data $store [x]`;
      const nativeExe = String.raw`C:\Lando User's\current $store [x]\lando.exe`;
      const convertedBin = "/c/Lando User's/current $store [x]";
      const snippet = renderPosixShellenv(nativeRoot, nativeExe);
      for (const initialPath of ["/usr/bin:/bin", `/legacy:${convertedBin}:/usr/bin:/bin`]) {
        const script = [
          `PATH='${initialPath.replaceAll("'", "'\"'\"'")}'`,
          snippet,
          '_lando_first_path="$PATH"',
          snippet,
          `printf '%s\\n%s\\n%s' "$_lando_first_path" "$PATH" "$LANDO_USER_DATA_ROOT"`,
        ].join("\n");
        const proc = Bun.spawn([gitBash, "--noprofile", "--norc", "-s"], {
          stdin: new TextEncoder().encode(script),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const [first, second, dataRoot] = stdout.split(/\r?\n/u);
        const expected = [
          convertedBin,
          ...initialPath.split(":").filter((entry) => entry !== convertedBin),
        ].join(":");
        expect(exitCode).toBe(0);
        expect(stderr).toBe("");
        expect(first).toBe(expected);
        expect(second).toBe(first);
        expect(dataRoot).toBe(nativeRoot);
      }
    },
  );

  test("native Windows POSIX paths leave PATH unchanged when cygpath is missing", async () => {
    const nativeRoot = String.raw`C:\Lando\data`;
    const snippet = renderPosixShellenv(nativeRoot, String.raw`C:\Lando\bin\lando.exe`);
    const proc = Bun.spawn(["/bin/sh", "-c", `${snippet}\nprintf '%s' "$PATH"`], {
      env: { PATH: "/no-cygpath" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("/no-cygpath");
    expect(stderr).toContain("Lando PATH setup needs cygpath");
  });

  for (const initial of ["/a:/b", "/a:DIR:/b", "/a:DIRx:/b", "DIR:/a:/b", "/a:DIR:/b:DIR", ":/a:DIR:"]) {
    test(`promotes one selected directory and preserves other PATH elements with ${initial}`, async () => {
      const root = "/tmp/Lando User's $Data [x]";
      const dir = `${root}/bin`;
      const initialPath = initial.replaceAll("DIR", dir);
      const expected = [dir, ...initialPath.split(":").filter((entry) => entry !== dir)].join(":");
      const snippet = renderPosixShellenv(root);
      const proc = Bun.spawn(["/bin/sh", "-c", `${snippet}\n${snippet}\nprintf '%s' "$PATH"`], {
        env: { PATH: initialPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      const result = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(result).toBe(expected);
      expect(result.split(":").filter((entry) => entry === dir)).toHaveLength(1);
    });
  }

  test("resolves the current lando before an older executable already first on PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-shellenv-resolution-"));
    try {
      const current = join(root, "current");
      const legacy = join(root, "legacy");
      await mkdir(current);
      await mkdir(legacy);
      await writeFile(join(current, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await writeFile(join(legacy, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const snippet = renderPosixShellenv(join(root, "data"), join(current, "lando"));
      const proc = Bun.spawn(["/bin/sh", "-c", `${snippet}\n${snippet}\ncommand -v lando`], {
        env: { PATH: `${legacy}:${current}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect((await new Response(proc.stdout).text()).trim()).toBe(join(current, "lando"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("escapes POSIX paths with spaces and single quotes", () => {
    const snippet = renderPosixShellenv("/tmp/Lando User's Data");
    expect(snippet).toContain("export LANDO_USER_DATA_ROOT='/tmp/Lando User'\"'\"'s Data'");
    expect(snippet).toContain("_lando_shellenv_path='/tmp/Lando User'\"'\"'s Data/bin'");
  });

  test("escapes PowerShell paths with spaces and single quotes", () => {
    expect(renderPowerShellShellenv("C:/Users/Lando User's Data")).toBe(
      "$Env:LANDO_USER_DATA_ROOT = 'C:/Users/Lando User''s Data'\n" +
        "$Env:PATH = (@('C:/Users/Lando User''s Data/bin') + @($Env:PATH -split [IO.Path]::PathSeparator | Where-Object { $_ -ne 'C:/Users/Lando User''s Data/bin' })) -join [IO.Path]::PathSeparator",
    );
  });

  const posixPowershell = process.platform === "win32" ? null : Bun.which("pwsh");
  test.skipIf(posixPowershell === null)(
    "POSIX PowerShell preserves distinct directories differing only by case",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "lando-shellenv-posix-powershell-"));
      try {
        const selected = "/opt/Lando/bin";
        const distinct = "/opt/lando/bin";
        const snippet = renderPowerShellShellenv(root, `${selected}/lando`);
        const script = [
          `$Env:PATH = '/other:${distinct}:${selected}'`,
          snippet,
          snippet,
          "[Console]::Write($Env:PATH)",
        ].join("\n");
        const result = await runCommand([
          posixPowershell as string,
          "-NoProfile",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(`${selected}:/other:${distinct}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  const powershell = Bun.which("powershell.exe") ?? Bun.which("pwsh");
  const windowsShell = powershell?.toLowerCase().endsWith(".exe") === true;
  const current = windowsShell ? String.raw`C:\Lando User's\current` : "/tmp/Lando User's/current";
  const legacy = windowsShell ? String.raw`C:\legacy` : "/legacy";
  const delimiter = windowsShell ? ";" : ":";
  for (const initial of [
    [legacy, current],
    [current, legacy],
    [legacy, current, "", current],
    [legacy, current.toUpperCase(), current],
  ]) {
    test.skipIf(powershell === null || powershell === undefined)(
      `PowerShell promotes current directory idempotently from ${initial.join(delimiter)}`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), "lando-shellenv-powershell-"));
        try {
          const executable = windowsShell ? `${current}\\lando.exe` : `${current}/lando`;
          const snippet = renderPowerShellShellenv(root, executable);
          const initialPath = initial.join(delimiter);
          const script = [
            `$Env:PATH = '${initialPath.replaceAll("'", "''")}'`,
            snippet,
            snippet,
            "[Console]::Write($Env:PATH)",
          ].join("\n");
          const result = await runCommand([
            powershell as string,
            "-NoProfile",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout.trim()).toBe(
            [
              current,
              ...initial.filter((entry) =>
                windowsShell ? entry.toLowerCase() !== current.toLowerCase() : entry !== current,
              ),
            ].join(delimiter),
          );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
});

const installFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando4-record-"));
  const custom = join(root, "custom ' $ [bin]");
  const paths = makeLandoPaths({ userDataRoot: root });
  const path = join(custom, "lando4");
  const bytes = "installed executable";
  const record = {
    version: 1 as const,
    data: {
      executable: {
        path,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        channel: "dev",
        platform: "linux-x64",
      },
      shellProfiles: [],
    },
  };
  await mkdir(custom);
  await mkdir(join(root, "install"));
  await writeFile(path, bytes);
  await writeFile(paths.installRecordFile, JSON.stringify(record));
  return {
    root,
    custom,
    paths,
    record,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
};

describe("record-backed shellenv", () => {
  test("uses the owned custom directory in both shell renderings", async () => {
    await using fixture = await installFixture();
    const { root, custom, paths } = fixture;
    expect(shellenvBinDir(root, "/opt/manual/lando")).toBe(custom);
    const posix = renderPosixShellenv(root);
    const powershell = renderPowerShellShellenv(root);
    const proc = Bun.spawn(["/bin/sh", "-c", `${posix}\n${posix}\nprintf '%s' "$PATH"`], {
      env: { PATH: "/a:/b" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(`${custom}:/a:/b`);
    expect(powershell).toContain(
      `Where-Object { $_ ${process.platform === "win32" ? "-ne" : "-cne"} '${custom.replaceAll("'", "''")}'`,
    );
    expect(powershell).toContain(`$Env:PATH = (@('${custom.replaceAll("'", "''")}'`);
    expect(posix + powershell).not.toContain(paths.binDir);
  });
  test("falls back to binDir only when the record is absent", async () => {
    await using fixture = await installFixture();
    await rm(fixture.paths.installRecordFile);
    expect(shellenvBinDir(fixture.root)).toBe(fixture.paths.binDir);
    expect(shellenvBinDir(fixture.root, "/opt/manual/lando")).toBe("/opt/manual");
  });
  for (const failure of ["json", "version", "schema", "digest", "symlink", "directory", "missing"] as const) {
    test(`fails closed with remediation when the record has ${failure} failure`, async () => {
      await using fixture = await installFixture();
      const { root, paths, record } = fixture;
      const file = paths.installRecordFile;
      switch (failure) {
        case "json":
          await writeFile(file, "{");
          break;
        case "version":
          await writeFile(file, JSON.stringify({ ...record, version: 2 }));
          break;
        case "schema":
          await writeFile(file, JSON.stringify({ ...record, extra: true }));
          break;
        case "digest":
          await writeFile(record.data.executable.path, "drifted");
          break;
        case "symlink":
          await rm(file);
          await symlink(record.data.executable.path, file);
          break;
        case "directory":
          await rm(file);
          await mkdir(file);
          break;
        case "missing":
          await rm(record.data.executable.path);
          break;
      }
      expect(() => shellenvBinDir(root, "/opt/manual/lando")).toThrow(
        expect.objectContaining({ _tag: "InstallRecordError" }),
      );
      for (const shellArgs of [[], ["--shell=powershell"]]) {
        const result = await runCommand(
          [process.execPath, "bin/lando.ts", "shellenv", ...shellArgs],
          coreRoot,
          {
            LANDO_USER_DATA_ROOT: root,
            LANDO_USER_CACHE_ROOT: join(root, "cache"),
            LANDO_USER_CONF_ROOT: join(root, "conf"),
          },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("InstallRecordError");
        expect(result.stderr).toMatch(/remediation|repair|installer/iu);
      }
    });
  }
  test("treats a regular executable under a parent directory symlink as owned", async () => {
    await using fixture = await installFixture();
    const { root, custom, record, paths } = fixture;
    const alias = join(root, "alias");
    await symlink(custom, alias);
    const recordedPath = join(alias, "lando4");
    const candidate = {
      ...record,
      data: {
        ...record.data,
        executable: { ...record.data.executable, path: recordedPath },
      },
    };
    await writeFile(paths.installRecordFile, JSON.stringify(candidate));
    const expected = installRecordOwnsDestination(
      candidate,
      recordedPath,
      { isFile: true, isSymbolicLink: false, isDirectory: false, size: record.data.executable.size },
      record.data.executable.sha256,
    );
    expect(expected).toEqual({ owned: true });
    expect(shellenvBinDir(root)).toBe(alias);
  });
  test("agrees with the engine ownership predicate for owned and every rejection verdict", async () => {
    for (const reason of ["owned", "not-regular-file", "digest-mismatch", "size-mismatch"] as const) {
      await using fixture = await installFixture();
      const { record, root, paths } = fixture;
      const executable = record.data.executable;
      const destination = executable.path;
      const stat = {
        isFile: reason !== "not-regular-file",
        isSymbolicLink: false,
        isDirectory: reason === "not-regular-file",
        size: executable.size,
      };
      const digest = reason === "digest-mismatch" ? "0".repeat(64) : executable.sha256;
      const candidate = {
        ...record,
        data: {
          ...record.data,
          executable: {
            ...executable,
            size: reason === "size-mismatch" ? executable.size + 1 : executable.size,
          },
        },
      };
      await writeFile(paths.installRecordFile, JSON.stringify(candidate));
      if (reason === "not-regular-file") {
        await rm(destination);
        await mkdir(destination);
      }
      if (reason === "digest-mismatch") await writeFile(destination, "changed");
      const expected = installRecordOwnsDestination(candidate, destination, stat, digest);
      if (expected.owned) expect(shellenvBinDir(root)).toBe(fixture.custom);
      else
        expect(() => shellenvBinDir(root)).toThrow(
          expect.objectContaining({
            _tag: "InstallRecordError",
            detail: expect.stringContaining(expected.reason),
            remediation: expect.any(String),
          }),
        );
    }
  });
});

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
};

describe("shell profile install path", () => {
  test("appends one LANDO4 block while preserving the generic LANDO block", async () => {
    // Given an existing Lando 3 profile block.
    const root = await mkdtemp(join(tmpdir(), "lando4-shellenv-"));
    const profile = join(root, "profile");
    const original = "# >>> LANDO shellenv >>>\nexport PATH=/lando3:$PATH\n# <<< LANDO shellenv <<<\n";
    try {
      await writeFile(profile, original);
      const command = [...shellProfileInstallCommand(root, profile)];
      // When installation is requested twice.
      expect((await runCommand(command)).exitCode).toBe(0);
      expect((await runCommand(command)).exitCode).toBe(0);
      const installed = await readFile(profile, "utf8");
      // Then the original bytes precede a distinct, single v4 block.
      expect(installed).toStartWith(`${original}\n# >>> LANDO4 shellenv >>>\n`);
      expect(installed).toEndWith("# <<< LANDO4 shellenv <<<\n");
      expect(installed.match(/# >>> LANDO4 shellenv >>>/gu)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("writes LANDO_SHELL_PROFILE when that env is set", () => {
    expect(
      defaultPosixShellProfilePath({
        LANDO_SHELL_PROFILE: "/tmp/custom-lando.rc",
        HOME: "/home/me",
        SHELL: "/bin/bash",
      }),
    ).toBe("/tmp/custom-lando.rc");

    const previous = process.env.LANDO_SHELL_PROFILE;
    try {
      process.env.LANDO_SHELL_PROFILE = "/tmp/custom-lando.rc";
      expect(shellProfileInstallCommand("/tmp/lando-data").join("\n")).toContain("/tmp/custom-lando.rc");
    } finally {
      restoreEnv("LANDO_SHELL_PROFILE", previous);
    }
  });

  test("falls back to the default POSIX profile when LANDO_SHELL_PROFILE is unset", () => {
    expect(defaultPosixShellProfilePath({ HOME: "/home/me", SHELL: "/bin/bash" })).toBe("/home/me/.bashrc");

    const previous = process.env.LANDO_SHELL_PROFILE;
    const previousHome = process.env.HOME;
    const previousShell = process.env.SHELL;
    try {
      Reflect.deleteProperty(process.env, "LANDO_SHELL_PROFILE");
      process.env.HOME = "/home/me";
      process.env.SHELL = "/bin/bash";
      expect(defaultPosixShellProfilePath()).toBe("/home/me/.bashrc");
      expect(shellProfileInstallCommand("/tmp/lando-data").join("\n")).toContain("/home/me/.bashrc");
    } finally {
      restoreEnv("LANDO_SHELL_PROFILE", previous);
      restoreEnv("HOME", previousHome);
      restoreEnv("SHELL", previousShell);
    }
  });
});
