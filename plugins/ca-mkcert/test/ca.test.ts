import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, type Context, Effect, Exit, Stream } from "effect";

import { CaError } from "@lando/sdk/errors";
import type { ToolArtifactEntry } from "@lando/sdk/schema";
import type {
  CertificateAuthorityShape,
  PrivilegeService,
  ProcessResult,
  ProcessRunner,
  ProcessSpawnOptions,
} from "@lando/sdk/services";
import { Downloader } from "@lando/sdk/services";
import { runCaContract } from "@lando/sdk/test";

import { makeFakeDownloader, sha256Hex } from "../../../sdk/test/tool-provisioning/_fixtures.ts";
import { makeMkcertCertificateAuthority, mkcertLeafCertificateName } from "../src/ca.ts";
import { MKCERT_TOOL_MANIFEST, mkcertInstallPath } from "../src/provision.ts";

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

const MKCERT_BIN = text("#!/bin/sh\necho mkcert\n");
const HOST_KEY = "linux-x64";
const SOURCE_URL = "https://example.test/linux-x64/mkcert";

interface RunCall {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
}

interface FakeProcessRunner {
  readonly service: Context.Tag.Service<typeof ProcessRunner>;
  readonly calls: () => ReadonlyArray<RunCall>;
}

const okResult = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });

/**
 * Fake `ProcessRunner` that emulates the mkcert CLI surface the CA drives:
 * `-CAROOT` prints the CA root, `-install` succeeds unless the test forces a
 * failure, and an issuance invocation writes the requested cert/key files.
 */
const makeFakeMkcertRunner = (options: {
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

interface FakePrivilege {
  readonly service: Context.Tag.Service<typeof PrivilegeService>;
  readonly calls: () => ReadonlyArray<ReadonlyArray<string>>;
}

const makeFakePrivilege = (result: ProcessResult = okResult()): FakePrivilege => {
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

interface Harness {
  readonly binDir: string;
  readonly certsDir: string;
  readonly toolDownloadsDir: string;
  readonly caRoot: string;
  readonly cleanup: () => Promise<void>;
}

const makeHarness = async (): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "lando-mkcert-ca-"));
  return {
    binDir: join(root, "bin"),
    certsDir: join(root, "certs"),
    toolDownloadsDir: join(root, "tool-downloads", "mkcert"),
    caRoot: join(root, "caroot"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const patchHostArtifact = (bytes: Uint8Array): (() => void) => {
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

const makeCa = (
  harness: Harness,
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

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const option = Cause.failureOption(exit.cause);
  if (option._tag !== "Some") throw new Error("expected a tagged failure");
  return option.value;
};

describe("mkcertLeafCertificateName", () => {
  test("maps wildcard and unsafe characters to contained file names", () => {
    expect(mkcertLeafCertificateName("myapp.lndo.site")).toBe("myapp.lndo.site");
    expect(mkcertLeafCertificateName("*.myapp.lndo.site")).toBe("_wildcard.myapp.lndo.site");
    expect(mkcertLeafCertificateName("../../escape")).not.toContain("/");
    expect(mkcertLeafCertificateName("..")).not.toMatch(/^\.+$/u);
  });
});

describe("mkcert CertificateAuthority", () => {
  test("provisions the binary, installs the local CA once, and issues a leaf certificate", async () => {
    const harness = await makeHarness();
    const restore = patchHostArtifact(MKCERT_BIN);
    try {
      const runner = makeFakeMkcertRunner({ caRoot: harness.caRoot });
      const { ca } = makeCa(harness, runner);

      await Effect.runPromise(ca.setup({ force: false }));

      const installedBinary = await readFile(mkcertInstallPath(harness.binDir, "linux"));
      expect(Array.from(installedBinary)).toEqual(Array.from(MKCERT_BIN));

      const installCalls = runner.calls().filter((call) => call.args[0] === "-install");
      expect(installCalls).toHaveLength(1);
      expect(installCalls[0]?.cmd).toBe(mkcertInstallPath(harness.binDir, "linux"));
      expect(installCalls[0]?.env?.CAROOT).toBe(harness.caRoot);

      const result = await Effect.runPromise(
        ca.issueCert({ cn: "myapp.lndo.site", sans: ["*.myapp.lndo.site", "localhost", "127.0.0.1"] }),
      );

      expect(result.certPath).toBe(join(harness.certsDir, "myapp.lndo.site.pem"));
      expect(result.keyPath).toBe(join(harness.certsDir, "myapp.lndo.site-key.pem"));
      expect(result.caPath).toBe(join(harness.caRoot, "rootCA.pem"));
      expect(await readFile(result.certPath, "utf-8")).toContain("BEGIN CERTIFICATE");
      expect(await readFile(result.keyPath, "utf-8")).toContain("BEGIN PRIVATE KEY");

      const issueCall = runner.calls().find((call) => call.args.includes("-cert-file"));
      expect(issueCall?.args).toEqual([
        "-cert-file",
        result.certPath,
        "-key-file",
        result.keyPath,
        "myapp.lndo.site",
        "*.myapp.lndo.site",
        "localhost",
        "127.0.0.1",
      ]);
    } finally {
      restore();
      await harness.cleanup();
    }
  });

  test("skipTrustInstall provisions the binary without touching any trust store", async () => {
    const harness = await makeHarness();
    const restore = patchHostArtifact(MKCERT_BIN);
    try {
      const runner = makeFakeMkcertRunner({ caRoot: harness.caRoot });
      const privilege = makeFakePrivilege();
      const { ca } = makeCa(harness, runner);

      await Effect.runPromise(
        ca.setup({ force: false, skipTrustInstall: true, privilege: privilege.service }),
      );

      await readFile(mkcertInstallPath(harness.binDir, "linux"));
      expect(runner.calls().filter((call) => call.args[0] === "-install")).toEqual([]);
      expect(privilege.calls()).toEqual([]);
    } finally {
      restore();
      await harness.cleanup();
    }
  });

  test("retries a failed trust-store install through PrivilegeService with the same CA root", async () => {
    const harness = await makeHarness();
    const restore = patchHostArtifact(MKCERT_BIN);
    try {
      const runner = makeFakeMkcertRunner({ caRoot: harness.caRoot, installExitCode: 1 });
      const privilege = makeFakePrivilege();
      const { ca } = makeCa(harness, runner);

      await Effect.runPromise(ca.setup({ force: false, privilege: privilege.service }));

      expect(privilege.calls()).toEqual([
        ["env", `CAROOT=${harness.caRoot}`, mkcertInstallPath(harness.binDir, "linux"), "-install"],
      ]);
    } finally {
      restore();
      await harness.cleanup();
    }
  });

  test("fails with actionable remediation when the trust-store install cannot be elevated", async () => {
    const harness = await makeHarness();
    const restore = patchHostArtifact(MKCERT_BIN);
    try {
      const runner = makeFakeMkcertRunner({
        caRoot: harness.caRoot,
        installExitCode: 1,
        installStderr: "permission denied writing to the system trust store",
      });
      const { ca } = makeCa(harness, runner);

      const error = failure(await Effect.runPromiseExit(ca.setup({ force: false })));

      expect(error).toBeInstanceOf(CaError);
      expect((error as CaError).caId).toBe("mkcert");
      expect((error as CaError).message).toContain("permission denied writing to the system trust store");
      expect((error as CaError).message).toContain("--skip-install-ca");
    } finally {
      restore();
      await harness.cleanup();
    }
  });

  test("fails with remediation on an unsupported host and never downloads", async () => {
    const harness = await makeHarness();
    const restore = patchHostArtifact(MKCERT_BIN);
    try {
      const runner = makeFakeMkcertRunner({ caRoot: harness.caRoot });
      const { ca, downloadCalls } = makeCa(harness, runner, { arch: "riscv64" });

      const error = failure(await Effect.runPromiseExit(ca.setup({ force: false })));

      expect(error).toBeInstanceOf(CaError);
      expect((error as CaError).message).toContain("linux-riscv64");
      expect((error as CaError).message).toContain("mkcert");
      expect(downloadCalls()).toBe(0);
      expect(runner.calls()).toEqual([]);
    } finally {
      restore();
      await harness.cleanup();
    }
  });

  test("issueCert before setup fails with the run-lando-setup remediation", async () => {
    const harness = await makeHarness();
    const restore = patchHostArtifact(MKCERT_BIN);
    try {
      const runner = makeFakeMkcertRunner({ caRoot: harness.caRoot });
      const { ca } = makeCa(harness, runner);

      const error = failure(await Effect.runPromiseExit(ca.issueCert({ cn: "myapp.lndo.site", sans: [] })));

      expect(error).toBeInstanceOf(CaError);
      expect((error as CaError).message).toContain("lando setup");
      expect(runner.calls()).toEqual([]);
    } finally {
      restore();
      await harness.cleanup();
    }
  });

  test("satisfies the CertificateAuthority contract suite", async () => {
    const harness = await makeHarness();
    const restore = patchHostArtifact(MKCERT_BIN);
    try {
      await mkdir(harness.caRoot, { recursive: true });
      const runner = makeFakeMkcertRunner({ caRoot: harness.caRoot });
      const { ca } = makeCa(harness, runner);

      const exit = await Effect.runPromiseExit(runCaContract(ca));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(ca.id).toBe("mkcert");
    } finally {
      restore();
      await harness.cleanup();
    }
  });
});
