import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, type Context, Effect, Exit, Stream } from "effect";

import type { ToolArtifactEntry } from "@lando/sdk/schema";
import type {
  CertificateAuthorityShape,
  PrivilegeService,
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from "@lando/sdk/services";
import { Downloader } from "@lando/sdk/services";

import { makeMkcertCertificateAuthority } from "../src/ca.ts";
import { MKCERT_TOOL_MANIFEST } from "../src/provision.ts";
import { makeFakeDownloader, sha256Hex } from "./support/fake-downloader.ts";

export const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

export const MKCERT_BIN = text("#!/bin/sh\necho mkcert\n");

export const HOST_KEY = "linux-x64";

export const SOURCE_URL = "https://example.test/linux-x64/mkcert";

export const okResult = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });

export const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const option = Cause.failureOption(exit.cause);
  if (option._tag !== "Some") throw new Error("expected a tagged failure");
  return option.value;
};

export interface TempDirs {
  readonly root: string;
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly cleanup: () => Promise<void>;
}

export const makeTempDirs = async (prefix: string): Promise<TempDirs> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    binDir: join(root, "bin"),
    toolDownloadsDir: join(root, "tool-downloads", "mkcert"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

export const patchArtifact = (key: string, entry: ToolArtifactEntry): (() => void) => {
  const artifacts = MKCERT_TOOL_MANIFEST.artifacts as Record<string, ToolArtifactEntry>;
  const original = artifacts[key];
  artifacts[key] = entry;
  return () => {
    if (original === undefined) delete artifacts[key];
    else artifacts[key] = original;
  };
};

export const patchHostBinary = (
  hostKey: string,
  bytes: Uint8Array,
  installName: string,
): { readonly url: string; readonly restore: () => void } => {
  const url = `https://example.test/${hostKey}/mkcert`;
  const restore = patchArtifact(hostKey, {
    url,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    installName,
  });
  return { url, restore };
};

export const patchHostArtifact = (bytes: Uint8Array): (() => void) => {
  const artifacts = MKCERT_TOOL_MANIFEST.artifacts as Record<string, ToolArtifactEntry>;
  const original = artifacts[HOST_KEY];
  artifacts[HOST_KEY] = {
    url: SOURCE_URL,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    installName: "mkcert",
  };
  return () => {
    if (original === undefined) delete artifacts[HOST_KEY];
    else artifacts[HOST_KEY] = original;
  };
};

export interface RunCall {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

export interface FakeProcessRunner {
  readonly service: Context.Tag.Service<typeof ProcessRunner>;
  readonly calls: () => ReadonlyArray<RunCall>;
}

export const makeFakeMkcertRunner = (options: {
  readonly caRoot: string;
  readonly installExitCode?: number;
  readonly installStderr?: string;
}): FakeProcessRunner => {
  const calls: RunCall[] = [];
  const run = async (input: ProcessSpawnOptions): Promise<ProcessResult> => {
    calls.push({
      cmd: input.cmd,
      args: [...input.args],
      ...(input.env === undefined ? {} : { env: { ...input.env } }),
    });
    if (input.args[0] === "-CAROOT") return okResult(`${options.caRoot}\n`);
    if (input.args[0] === "-install") {
      const exitCode = options.installExitCode ?? 0;
      return exitCode === 0
        ? okResult("The local CA is now installed in the system trust store!\n")
        : { exitCode, stdout: "", stderr: options.installStderr ?? "permission denied" };
    }
    const certFile = input.args[input.args.indexOf("-cert-file") + 1];
    const keyFile = input.args[input.args.indexOf("-key-file") + 1];
    if (certFile === undefined || keyFile === undefined) {
      return { exitCode: 2, stdout: "", stderr: `unexpected mkcert invocation: ${input.args.join(" ")}` };
    }
    await writeFile(certFile, "-----BEGIN CERTIFICATE-----\n");
    await writeFile(keyFile, "-----BEGIN PRIVATE KEY-----\n");
    return okResult("");
  };

  return {
    service: {
      run: (input) => Effect.promise(() => run(input)),
      stream: () => Stream.die(new Error("stream is not used by the mkcert certificate authority")),
    },
    calls: () => [...calls],
  };
};

export interface FakePrivilege {
  readonly service: Context.Tag.Service<typeof PrivilegeService>;
  readonly calls: () => ReadonlyArray<ReadonlyArray<string>>;
}

export const makeFakePrivilege = (result: ProcessResult = okResult()): FakePrivilege => {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    service: {
      elevate: (command) =>
        Effect.sync(() => {
          calls.push([...command]);
          return result;
        }),
    },
    calls: () => [...calls],
  };
};

export interface CaHarness {
  readonly binDir: string;
  readonly certsDir: string;
  readonly toolDownloadsDir: string;
  readonly caRoot: string;
  readonly cleanup: () => Promise<void>;
}

export const makeCaHarness = async (): Promise<CaHarness> => {
  const dirs = await makeTempDirs("lando-mkcert-ca-");
  return {
    binDir: dirs.binDir,
    certsDir: join(dirs.root, "certs"),
    toolDownloadsDir: dirs.toolDownloadsDir,
    caRoot: join(dirs.root, "caroot"),
    cleanup: dirs.cleanup,
  };
};

export const makeCa = (
  harness: CaHarness,
  runner: FakeProcessRunner,
  overrides: { readonly arch?: string } = {},
): { readonly ca: CertificateAuthorityShape; readonly downloadCalls: () => number } => {
  const downloader = makeFakeDownloader();
  downloader.serve(SOURCE_URL, MKCERT_BIN);
  const downloaderService = Effect.runSync(Effect.provide(Downloader, downloader.layer));
  return {
    ca: makeMkcertCertificateAuthority({
      binDir: harness.binDir,
      certsDir: harness.certsDir,
      toolDownloadsDir: harness.toolDownloadsDir,
      downloader: downloaderService,
      processRunner: runner.service,
      platform: "linux",
      arch: overrides.arch ?? "x64",
    }),
    downloadCalls: downloader.downloadCalls,
  };
};
