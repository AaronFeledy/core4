import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const dockerfilePath = join(repoRoot, "scripts/runtime-bundle-builder/Dockerfile");
const nativeTest = process.platform === "linux" ? test : test.skip;
const pathEntryExists = async (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );
const architectures = [
  { arch: "amd64", triple: "x86_64-unknown-linux-gnu" },
  { arch: "arm64", triple: "aarch64-unknown-linux-gnu" },
] as const;

const selectionCommand = (dockerfile: string, link: string): string => {
  const start = dockerfile.indexOf('RUN --network=none case "$TARGETARCH" in');
  const end = dockerfile.indexOf("\nENV PATH=", start);
  if (start < 0 || end < 0) throw new Error("Missing offline Rust selection RUN in Dockerfile");
  const command = dockerfile.slice(start, end).replace(/^RUN --network=none /u, "");
  expect(command.match(/\/usr\/local\/rust-toolchain/gu)).toHaveLength(1);
  return command.replaceAll("/usr/local/rust-toolchain", link).replaceAll(/\\\n\s*/gu, " ");
};

const writeExecutable = async (path: string, body: string): Promise<void> => {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
};

const withFixture = async (
  run: (fixture: {
    root: string;
    rustup: string;
    link: string;
    proxyBin: string;
    marker: string;
  }) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "rb-rust-select-"));
  const rustup = join(root, "rustup");
  const link = join(root, "selected-toolchain");
  const proxyBin = join(root, "rustup-proxies");
  const marker = join(root, "proxy-used");
  try {
    await mkdir(proxyBin, { recursive: true });
    for (const name of ["rustc", "cargo"]) {
      await writeExecutable(join(proxyBin, name), `touch "${marker}"; echo rustup-proxy-was-used; exit 88`);
    }
    await run({ root, rustup, link, proxyBin, marker });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const runSelection = async (options: {
  dockerfile: string;
  rustup: string;
  link: string;
  proxyBin: string;
  arch: string;
}): Promise<{ exitCode: number; output: string }> => {
  const child = Bun.spawn(
    ["bash", "-euo", "pipefail", "-c", selectionCommand(options.dockerfile, options.link)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TARGETARCH: options.arch,
        RUSTUP_HOME: options.rustup,
        PATH: `${options.proxyBin}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
};

const writeToolchain = async (
  root: string,
  version: string,
  triple: string,
  names: readonly string[],
): Promise<string> => {
  const toolchain = join(root, "toolchains", `${version}-${triple}`);
  await mkdir(join(toolchain, "bin"), { recursive: true });
  for (const name of names) {
    await writeExecutable(join(toolchain, "bin", name), `printf '${name} ${version}\\n'`);
  }
  return toolchain;
};

describe("pinned Rust selection in the production Dockerfile", () => {
  nativeTest.each(architectures)(
    "selects installed Rust 1.88.0 for $arch without rustup proxies",
    async ({ arch, triple }) => {
      const dockerfile = await readFile(dockerfilePath, "utf8");
      await withFixture(async ({ rustup, link, proxyBin, marker }) => {
        const pinned = await writeToolchain(rustup, "1.88.0", triple, ["rustc", "cargo"]);
        await writeToolchain(rustup, "1.99.1", triple, ["rustc", "cargo"]);
        const selected = await runSelection({ dockerfile, rustup, link, proxyBin, arch });
        expect(selected.exitCode).toBe(0);
        expect(await realpath(link)).toBe(pinned);
        const verify = Bun.spawn(
          [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            "command -v rustc; rustc --version; command -v cargo; cargo --version",
          ],
          {
            env: { ...process.env, PATH: `${link}/bin:${proxyBin}:${process.env.PATH ?? ""}` },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [verifyCode, output] = await Promise.all([verify.exited, new Response(verify.stdout).text()]);
        expect(verifyCode).toBe(0);
        expect(output).toContain(`${link}/bin/rustc\nrustc 1.88.0\n`);
        expect(output).toContain(`${link}/bin/cargo\ncargo 1.88.0\n`);
        expect(await Bun.file(marker).exists()).toBe(false);
      });
    },
  );

  nativeTest.each(architectures)(
    "rejects incomplete or missing pinned toolchain for $arch",
    async ({ arch, triple }) => {
      const dockerfile = await readFile(dockerfilePath, "utf8");
      for (const names of [[], ["rustc"], ["cargo"]]) {
        await withFixture(async ({ rustup, link, proxyBin, marker }) => {
          await writeToolchain(rustup, "1.99.1", triple, ["rustc", "cargo"]);
          if (names.length > 0) await writeToolchain(rustup, "1.88.0", triple, names);
          const selected = await runSelection({ dockerfile, rustup, link, proxyBin, arch });
          expect(selected.exitCode).not.toBe(0);
          expect(await pathEntryExists(link)).toBe(false);
          expect(await Bun.file(marker).exists()).toBe(false);
        });
      }
    },
  );

  nativeTest("rejects unsupported target architecture before selecting a toolchain", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    await withFixture(async ({ rustup, link, proxyBin, marker }) => {
      const selected = await runSelection({ dockerfile, rustup, link, proxyBin, arch: "riscv64" });
      expect(selected.exitCode).not.toBe(0);
      expect(selected.output).toContain("Unsupported Rust target architecture: riscv64");
      expect(await pathEntryExists(link)).toBe(false);
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  });

  test("uses the selected real binaries and checks exact versions without network", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain("ENV PATH=/usr/local/go/bin:/usr/local/rust-toolchain/bin:$PATH");
    expect(dockerfile).not.toContain("RUSTUP_TOOLCHAIN=stable");
    expect(dockerfile).not.toContain("PATH=/usr/local/go/bin:/usr/local/cargo/bin");
    expect(dockerfile).toContain('RUN --network=none test "$(go env GOVERSION)" = go1.25.6');
    expect(dockerfile).toContain("test \"$(rustc --version | cut -d ' ' -f2)\" = 1.88.0");
    expect(dockerfile).toContain("test \"$(cargo --version | cut -d ' ' -f2)\" = 1.88.0");
  });
});
