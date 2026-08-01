import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit } from "effect";

import { CaError } from "@lando/sdk/errors";
import { runCaContract } from "@lando/sdk/test";

import { mkcertLeafCertificateName } from "../src/ca.ts";
import { mkcertInstallPath } from "../src/provision.ts";
import {
  MKCERT_BIN,
  failure,
  makeCa,
  makeCaHarness,
  makeFakeMkcertRunner,
  makeFakePrivilege,
  patchHostArtifact,
} from "./_fixtures.ts";

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
    const harness = await makeCaHarness();
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
        ca.issueCert({
          cn: "myapp.lndo.site",
          sans: ["service", "myapp.lndo.site", "*.myapp.lndo.site", "localhost", "127.0.0.1"],
        }),
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
        "--",
        "service",
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

  test("terminates option parsing before option-shaped certificate names", async () => {
    const harness = await makeCaHarness();
    const restore = patchHostArtifact(MKCERT_BIN);
    try {
      const runner = makeFakeMkcertRunner({ caRoot: harness.caRoot });
      const { ca } = makeCa(harness, runner);
      await Effect.runPromise(ca.setup({ force: false, skipTrustInstall: true }));

      const result = await Effect.runPromise(
        ca.issueCert({
          cn: "-uninstall",
          sans: ["-cert-file", "/tmp/overwrite.pem", "-key-file"],
        }),
      );

      const issueCall = runner.calls().find((call) => call.args.includes("-cert-file"));
      expect(issueCall?.args).toEqual([
        "-cert-file",
        result.certPath,
        "-key-file",
        result.keyPath,
        "--",
        "-cert-file",
        "/tmp/overwrite.pem",
        "-key-file",
        "-uninstall",
      ]);
    } finally {
      restore();
      await harness.cleanup();
    }
  });

  test("skipTrustInstall provisions the binary without touching any trust store", async () => {
    const harness = await makeCaHarness();
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
    const harness = await makeCaHarness();
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
    const harness = await makeCaHarness();
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
    const harness = await makeCaHarness();
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
    const harness = await makeCaHarness();
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
    const harness = await makeCaHarness();
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
