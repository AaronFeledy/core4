import { basename, join } from "node:path";

import { isLinuxRuntimeBundle } from "./runtime-bundle-sources.ts";

export type InspectCommandRunner = (cmd: ReadonlyArray<string>, cwd?: string) => Promise<string>;

const inspectCommand: InspectCommandRunner = async (cmd, cwd) => {
  const proc = Bun.spawn({
    cmd: [...cmd],
    ...(cwd === undefined ? {} : { cwd }),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TZ: "UTC" },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0)
    throw new Error(
      `assemble-runtime-bundle: dependency inspection failed (${exitCode}): ${cmd.join(" ")}${stderr.length === 0 ? "" : `\n${stderr}`}`,
    );
  return stdout;
};

const reviewedLinuxSonames = new Set([
  "ld-linux-aarch64.so.1",
  "ld-linux-x86-64.so.2",
  "libassuan.so.0",
  "libassuan.so.9",
  "libaudit.so.1",
  "libblkid.so.1",
  "libbtrfs.so.0",
  "libc.so.6",
  "libcap.so.2",
  "libcrypto.so.3",
  "libdevmapper.so.1.02.1",
  "libdl.so.2",
  "libgpg-error.so.0",
  "libgpgme.so.11",
  "liblz4.so.1",
  "liblzma.so.5",
  "libm.so.6",
  "libpcre2-8.so.0",
  "libpthread.so.0",
  "libresolv.so.2",
  "librt.so.1",
  "libseccomp.so.2",
  "libselinux.so.1",
  "libsqlite3.so.0",
  "libsystemd.so.0",
  "libudev.so.1",
  "libuuid.so.1",
  "libzstd.so.1",
  "linux-vdso.so.1",
]);

const sonameFromLddLine = (line: string): string | undefined => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const [dependency] = trimmed.split("=>", 1);
  const token = dependency?.trim().split(/\s+/u)[0];
  if (token === undefined || token.length === 0) return undefined;
  return basename(token);
};

const PodmanPortabilityArtifacts = ["bin/podman", "bin/rootlessport"] as const;

const assertPortableLinuxDependency = (artifactPath: string, line: string): void => {
  const soname = sonameFromLddLine(line);
  if (soname === undefined) return;
  if (/=>\s+not found\b/u.test(line)) {
    throw new Error(
      `assemble-runtime-bundle: Linux Podman artifact ${artifactPath} dependency ${soname} is not found`,
    );
  }
  if (soname.startsWith("libsubid.so")) {
    throw new Error(
      `assemble-runtime-bundle: Linux Podman artifact ${artifactPath} links forbidden dependency ${soname}`,
    );
  }
  if (!reviewedLinuxSonames.has(soname)) {
    throw new Error(
      `assemble-runtime-bundle: Linux Podman artifact ${artifactPath} dependency ${soname} is outside the reviewed Linux dynamic baseline`,
    );
  }
};

export const verifyLinuxPodmanPortability = async (
  hostKey: string,
  stageDir: string,
  inspect: InspectCommandRunner = inspectCommand,
): Promise<void> => {
  if (!isLinuxRuntimeBundle(hostKey)) return;
  for (const artifact of PodmanPortabilityArtifacts) {
    const artifactPath = join(stageDir, artifact);
    const stdout = await inspect(["ldd", artifactPath]);
    if (stdout.trim().length === 0) {
      throw new Error(`assemble-runtime-bundle: Linux Podman artifact ${artifactPath} ldd output is empty`);
    }
    for (const line of stdout.split("\n")) assertPortableLinuxDependency(artifactPath, line);
  }
};
