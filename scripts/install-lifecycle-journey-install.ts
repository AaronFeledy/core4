import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const LIFECYCLE_SIGNATURE_LIMITATION =
  "Test-only distribution signature verifier fixture; SHA256 and installer ownership are real. This does not prove release signature validity. Signature trust has independent installer unit tests.";

export const prepareLifecycleDistribution = async (binary: string, workDir: string) => {
  const windows = process.platform === "win32";
  const platform = windows ? "windows-x64" : "linux-x64";
  const releaseDir = join(workDir, "distribution-fixture");
  await mkdir(releaseDir);
  const artifact = `lando-${platform}${windows ? ".exe" : ""}`;
  const payload = join(releaseDir, artifact);
  await copyFile(binary, payload);
  const bytes = await Bun.file(payload).arrayBuffer();
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const sums = join(releaseDir, "SHA256SUMS");
  const signature = `${sums}.${windows ? "sig" : "asc"}`;
  await writeFile(sums, `${sha256}  ${artifact}\n`);
  await writeFile(signature, "TEST-ONLY distribution fixture, not a release signature\n");
  const manifest = join(releaseDir, "dev.json");
  await writeFile(
    manifest,
    JSON.stringify({
      channel: "dev",
      latest: "4.0.0-lifecycle-fixture",
      binaries: { [platform]: { url: pathToFileURL(payload).href, sha256, size: bytes.byteLength } },
      checksums: { url: pathToFileURL(sums).href, signature: pathToFileURL(signature).href },
    }),
  );
  const verifier = join(releaseDir, windows ? "fixture-cosign.ps1" : "fixture-gpg.sh");
  await writeFile(
    verifier,
    windows
      ? '$ErrorActionPreference = "Stop"\nexit 0\n'
      : '#!/bin/sh\ncase "$*" in *--import*) exit 0 ;; *--verify*) exit 0 ;; *) exit 2 ;; esac\n',
  );
  await chmod(verifier, 0o700);
  if (windows) await writeFile(`${sums}.crt`, "TEST-ONLY certificate fixture\n");
  const installer = resolve(import.meta.dirname, windows ? "install.ps1" : "install.sh");
  return {
    sha256,
    platform,
    argv: windows
      ? ["pwsh", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer]
      : ["sh", installer],
    env: {
      LANDO_CHANNEL: "dev",
      LANDO_INSTALL_MANIFEST_URL: pathToFileURL(manifest).href,
      LANDO_INSTALL_NONINTERACTIVE: "1",
      LANDO_INSTALL_SKIP_SETUP: "1",
      LANDO_INSTALL_RUN_SETUP: "0",
      LANDO_INSTALL_GPG: verifier,
      LANDO_INSTALL_COSIGN: verifier,
      LANDO_INSTALL_WINDOWS_ARCH: "AMD64",
      LANDO_INSTALL_OS: "Linux",
      LANDO_INSTALL_ARCH: "x86_64",
      LANDO_INSTALL_LIBC: "glibc",
    },
  };
};
