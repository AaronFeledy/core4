import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Effect } from "effect";
import {
  buildDownloadRequest,
  selectNodeRuntime,
  selectRunnerArchive,
  validateDownloadResult,
} from "../src/pins.ts";

const options = { runtime: "node20", os: "linux", arch: "x64", libc: "glibc", source: "nodejs" };
const download = {
  artifactId: "node-v20.20.2-linux-x64.tar.gz",
  directory: resolve(tmpdir(), "lando-pin-unit-artifacts"),
  offline: true,
};
const failed = <A>(effect: Effect.Effect<A, { readonly reason: string }>) =>
  Effect.runSync(Effect.flip(effect));

describe("private Node runtime pins", () => {
  test("selects each exact runtime, architecture and source with the matching archive and member", () => {
    for (const runtime of ["node20", "node24"] as const) {
      for (const arch of ["x64", "arm64"] as const) {
        for (const source of ["nodejs", "runner-externals"] as const) {
          const selected = Effect.runSync(selectNodeRuntime({ ...options, runtime, arch, source }));
          expect(selected.runtime.runtime).toBe(runtime);
          expect(selected.runtime.arch).toBe(arch);
          expect(selected.runtime.source).toBe(source);
          expect(selected.runtime.nodeVersion).toBe(runtime === "node20" ? "20.20.2" : "24.22.1");
          expect(selected.artifact.arch).toBe(arch);
          expect(selected.artifact.checksumSourceUrl).toBe(
            source === "nodejs"
              ? `https://nodejs.org/dist/v${selected.runtime.nodeVersion}/SHASUMS256.txt`
              : "https://github.com/actions/runner/releases/tag/v2.338.1",
          );
          expect(selected.artifact.filename).toBe(selected.runtime.artifactId);
          expect(selected.runtime.binary.elfMachine).toBe(arch === "x64" ? 62 : 183);
          expect(selected.runtime.binary.sha256).toMatch(/^[a-f0-9]{64}$/u);
          expect(selected.runtime.member).toBe(
            source === "nodejs"
              ? `node-v${selected.runtime.nodeVersion}-linux-${arch}/bin/node`
              : `./externals/${runtime}/bin/node`,
          );
          expect(selected.runtime.runnerRelativePath).toBe(
            source === "runner-externals" ? `externals/${runtime}/bin/node` : undefined,
          );
        }
      }
    }
  });

  test("binds standalone Node to the byte-identical runner externals for both architectures", () => {
    for (const runtime of ["node20", "node24"] as const)
      for (const arch of ["x64", "arm64"] as const) {
        const standalone = Effect.runSync(selectNodeRuntime({ ...options, runtime, arch }));
        const remote = Effect.runSync(
          selectNodeRuntime({ ...options, runtime, arch, source: "runner-externals" }),
        );
        expect(remote.runtime.binary).toEqual(standalone.runtime.binary);
        expect(remote.artifact.kind).toBe("runner-archive");
        expect(remote.artifact.version).toBe("2.338.1");
      }
  });

  test("selects runner archives without host or PATH inference", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const pin = Effect.runSync(selectRunnerArchive({ os: "linux", arch, libc: "glibc" }));
      expect(pin.filename).toBe(`actions-runner-linux-${arch}-2.338.1.tar.gz`);
      expect(pin.checksumSourceUrl).toBe("https://github.com/actions/runner/releases/tag/v2.338.1");
      expect(pin.url).toBe(`https://github.com/actions/runner/releases/download/v2.338.1/${pin.filename}`);
    }
  });

  test("refuses Alpine, musl, unsupported architectures and runtimes before acquisition", () => {
    for (const patch of [
      { os: "alpine" },
      { os: "darwin" },
      { os: "win32" },
      { arch: "armv7l" },
      { arch: "amd64" },
      { libc: "musl" },
      { runtime: "node22" },
      { runtime: "bun" },
      { source: "PATH" },
    ]) {
      expect(failed(selectNodeRuntime({ ...options, ...patch })).reason).toBe("unsupported-runtime");
    }
    expect(failed(selectRunnerArchive({ os: "linux", arch: "arm64", libc: "musl" })).reason).toBe(
      "unsupported-runtime",
    );
  });

  test("strictly rejects unknown, missing and unbounded request fields without retaining values", () => {
    for (const input of [
      undefined,
      {},
      { ...options, extra: "secret" },
      { ...options, runtime: "secret".repeat(10000) },
      { ...options, os: null },
      { ...options, source: "https://secret.invalid" },
    ]) {
      const error = failed(selectNodeRuntime(input));
      expect(JSON.stringify(error)).not.toContain("secret");
      expect(error.reason).toBe("unsupported-runtime");
    }
  });

  test("builds only a checksum and exact size pinned SDK host file request with explicit offline intent", () => {
    const request = Effect.runSync(buildDownloadRequest(download));
    const { artifact } = Effect.runSync(selectNodeRuntime(options));
    expect(request).toEqual({
      url: artifact.url,
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      destination: { kind: "file", directory: download.directory, filename: artifact.filename },
      allowFileSource: false,
      offline: true,
      callerId: "github-actions-pins",
    });
    for (const patch of [
      { offline: undefined },
      { extra: true },
      { artifactId: "node-latest" },
      { directory: `${download.directory}${sep}..${sep}secret` },
      { directory: `${download.directory}${sep}${sep}secret` },
      { directory: "relative" },
      { directory: `${download.directory}\nsecret` },
      { directory: resolve(download.directory, "..", "..", "..", "..", "..", "..", "..", "..") },
    ]) {
      expect(failed(buildDownloadRequest({ ...download, ...patch })).reason).toBe("invalid-download-request");
    }
  });

  test("checks structural consistency of a trusted host DownloadResult, including offline cache misses", () => {
    const { artifact } = Effect.runSync(selectNodeRuntime(options));
    const receipt = {
      url: artifact.url,
      kind: "file" as const,
      path: join(download.directory, download.artifactId),
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      fromCache: true,
    };
    expect(Effect.runSync(validateDownloadResult(download, receipt))).toEqual(receipt);
    expect(failed(validateDownloadResult(download, undefined)).reason).toBe("offline-artifact-missing");
    for (const patch of [
      { sha256: "0".repeat(64) },
      { sizeBytes: 1 },
      { kind: "memory" },
      { path: "/elsewhere/secret" },
      { url: "https://secret.invalid" },
      { fromCache: false },
      { extra: "secret" },
    ]) {
      const error = failed(validateDownloadResult(download, { ...receipt, ...patch }));
      expect(error.reason).toBe("download-receipt-mismatch");
      expect(JSON.stringify(error)).not.toContain("secret");
    }
    expect(failed(validateDownloadResult({ ...download, offline: false }, undefined)).reason).toBe(
      "artifact-missing",
    );
  });
});
