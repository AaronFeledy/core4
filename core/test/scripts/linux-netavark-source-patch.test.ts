import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLinuxHelperFromSource } from "../../../scripts/linux-podman-source-build.ts";
import {
  LinuxAardvarkDnsSourceBuild,
  LinuxNetavarkSourceBuild,
  type RuntimeBundleComponent,
} from "../../../scripts/runtime-bundle-sources.ts";

const upstreamAardvarkSource = `use std::path::{Path, PathBuf};
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
        let mut aardvark_args = vec![];
        // only use systemd when it is booted
        if is_using_systemd() && Aardvark::is_executable_in_path(SYSTEMD_RUN) {
            aardvark_args = vec![OsStr::new(SYSTEMD_RUN)];
        }
    }
}
`;

const patchedAardvarkSource = `use std::os::unix::net::UnixStream;
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

    fn has_usable_systemd_user_bus() -> bool {
        let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") else {
            return false;
        };
        UnixStream::connect(Path::new(&runtime_dir).join("bus")).is_ok()
    }

    pub fn start_aardvark_server(&self) -> NetavarkResult<()> {
        let mut aardvark_args = vec![];
        // only use systemd when it is booted
        if is_using_systemd()
            && Aardvark::is_executable_in_path(SYSTEMD_RUN)
            && (!self.rootless || Aardvark::has_usable_systemd_user_bus())
        {
            aardvark_args = vec![OsStr::new(SYSTEMD_RUN)];
        }
    }
}
`;

const sourceInput = {
  name: "source",
  url: "https://example.test/source.tar.gz",
  sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  archive: "tar.gz",
} as const;
const vendorInput = {
  name: "vendor",
  url: "https://example.test/vendor.tar.gz",
  sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  archive: "tar.gz",
} as const;
const netavarkComponent = {
  name: "netavark",
  version: "2.0.0",
  sourceBuild: LinuxNetavarkSourceBuild,
  inputs: [sourceInput, vendorInput],
  outputs: [{ source: "target/release/netavark", installName: "bin/netavark", mode: 0o755 }],
} satisfies RuntimeBundleComponent;
const aardvarkComponent = {
  name: "aardvark-dns",
  version: "2.0.0",
  sourceBuild: LinuxAardvarkDnsSourceBuild,
  inputs: [sourceInput, vendorInput],
  outputs: [{ source: "target/release/aardvark-dns", installName: "bin/aardvark-dns", mode: 0o755 }],
} satisfies RuntimeBundleComponent;

type LinuxHelperFixtureComponent = typeof netavarkComponent | typeof aardvarkComponent;

const buildFixture = async (component: LinuxHelperFixtureComponent, source: string): Promise<string> => {
  const stageDir = await mkdtemp(join(tmpdir(), "netavark-patch-stage-"));
  let observedSource: string | undefined;
  try {
    await buildLinuxHelperFromSource({
      component,
      artifactPaths: new Map([
        ["source", "/fixture/source.tar.gz"],
        ["vendor", "/fixture/vendor.tar.gz"],
      ]),
      stageDir,
      execute: async (command, cwd) => {
        if (command[0] === "tar" && command.includes("-xf")) {
          const workDir = command.at(-1);
          if (workDir === undefined) throw new Error("source extraction requires a work directory");
          const sourceDir = join(workDir, `${component.name}-${component.version}`);
          await mkdir(join(sourceDir, "src", "dns"), { recursive: true });
          await writeFile(join(sourceDir, "src", "dns", "aardvark.rs"), source);
          return;
        }
        if (!command.includes("cargo")) return;
        if (cwd === undefined) throw new Error("source build requires cwd");
        observedSource = await readFile(join(cwd, "src", "dns", "aardvark.rs"), "utf8");
        const output = component.outputs[0];
        if (output === undefined) throw new Error("source fixture requires an output");
        await mkdir(join(cwd, "target", "release"), { recursive: true });
        await writeFile(join(cwd, output.source), "fixture-binary");
      },
    });
    if (observedSource === undefined) throw new Error("source build did not run");
    return observedSource;
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
};

describe("Linux Netavark source patch", () => {
  test("applies the user-bus Aardvark launcher patch only to Netavark", async () => {
    // Given: Netavark and Aardvark source builds contain the same upstream fixture text.
    const netavarkBuild = buildFixture(netavarkComponent, upstreamAardvarkSource);
    const aardvarkBuild = buildFixture(aardvarkComponent, upstreamAardvarkSource);

    // When: both Linux helper source-build seams run.
    const [netavarkSource, aardvarkSource] = await Promise.all([netavarkBuild, aardvarkBuild]);

    // Then: only Netavark gets the exact rootless user-bus decision patch.
    expect(netavarkSource).toBe(patchedAardvarkSource);
    expect(aardvarkSource).toBe(upstreamAardvarkSource);
  });

  test("fails loudly when Netavark upstream launcher text drifts", async () => {
    // Given: the pinned source no longer contains the exact v2.0.0 launcher condition.
    const driftedSource = upstreamAardvarkSource.replace("is_using_systemd()", "systemd_is_booted()");

    // When: the deterministic Netavark source-build patch is applied.
    const build = buildFixture(netavarkComponent, driftedSource);
    let failure: unknown;
    try {
      await build;
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      failure = cause;
    }

    // Then: source drift aborts the build instead of producing an unpatched binary.
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toMatch(
      /Netavark v2\.0\.0.*upstream text mismatch/u,
    );
  });
});
