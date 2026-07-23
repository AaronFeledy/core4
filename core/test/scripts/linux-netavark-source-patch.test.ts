import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NETAVARK_SYSTEMD_USER_BUS_PATCH_PATH,
  applyVerifiedSourcePatch,
} from "../../../scripts/linux-podman-source-build.ts";

const upstreamSource = `use std::io::Write;
use std::net::Ipv4Addr;
use std::net::{IpAddr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

impl Aardvark {
    fn is_executable_in_path(program: &str) -> bool {
        if let Ok(path) = std::env::var("PATH") {
            for p in path.split(':') {
                let p_str = format!("{p}/{program}");
                if fs::metadata(p_str).is_ok() {
                    return true;
                }
            }
        }
        false
    }

    pub fn start_aardvark_server(&self) -> NetavarkResult<()> {
        log::debug!("Spawning aardvark server");

        let mut aardvark_args = vec![];
        // only use systemd when it is booted
        if is_using_systemd() && Aardvark::is_executable_in_path(SYSTEMD_RUN) {
            // TODO: This could be replaced by systemd-api.
            aardvark_args = vec![
                OsStr::new(SYSTEMD_RUN),
            ];
        }
    }
}
`;

const patchedSource = upstreamSource
  .replace(
    "use std::path::{Path, PathBuf};",
    "use std::os::unix::net::UnixStream;\nuse std::path::{Path, PathBuf};",
  )
  .replace(
    "    pub fn start_aardvark_server(&self) -> NetavarkResult<()> {",
    `    fn has_usable_systemd_user_bus() -> bool {
        let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") else {
            return false;
        };
        UnixStream::connect(Path::new(&runtime_dir).join("bus")).is_ok()
    }

    pub fn start_aardvark_server(&self) -> NetavarkResult<()> {`,
  )
  .replace(
    "        if is_using_systemd() && Aardvark::is_executable_in_path(SYSTEMD_RUN) {",
    `        if is_using_systemd()
            && Aardvark::is_executable_in_path(SYSTEMD_RUN)
            && (!self.rootless || Aardvark::has_usable_systemd_user_bus())
        {`,
  );

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const executePatch = async (command: ReadonlyArray<string>, cwd?: string): Promise<void> => {
  const process = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(`patch failed with exit ${exitCode}: ${stderr}`);
};

describe("Linux Netavark source patch", () => {
  test("applies the checked-in user-bus patch with exact before and after hashes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "netavark-patch-"));
    try {
      const sourceDir = join(dir, "netavark-2.0.0");
      const sourcePath = join(sourceDir, "src", "dns", "aardvark.rs");
      await mkdir(join(sourceDir, "src", "dns"), { recursive: true });
      await Bun.write(sourcePath, upstreamSource);

      await applyVerifiedSourcePatch({
        sourceDir,
        sourcePath,
        patchPath: NETAVARK_SYSTEMD_USER_BUS_PATCH_PATH,
        expectedSourceSha256: sha256(upstreamSource),
        expectedPatchedSha256: sha256(patchedSource),
        execute: executePatch,
      });

      expect(await readFile(sourcePath, "utf8")).toBe(patchedSource);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects source drift before invoking patch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "netavark-patch-drift-"));
    try {
      const sourcePath = join(dir, "aardvark.rs");
      await writeFile(sourcePath, upstreamSource.replace("is_using_systemd", "systemd_is_booted"));
      let patchInvocations = 0;

      const result = applyVerifiedSourcePatch({
        sourceDir: dir,
        sourcePath,
        patchPath: NETAVARK_SYSTEMD_USER_BUS_PATCH_PATH,
        expectedSourceSha256: sha256(upstreamSource),
        expectedPatchedSha256: sha256(patchedSource),
        execute: async () => {
          patchInvocations += 1;
        },
      });

      await expect(result).rejects.toThrow(/source SHA-256 mismatch/u);
      expect(patchInvocations).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
