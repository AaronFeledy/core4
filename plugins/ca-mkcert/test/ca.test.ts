import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CaError } from "@lando/sdk/errors";
import { CertificateName } from "@lando/sdk/schema";
import { TEST_CERTIFICATES, runCaContract } from "@lando/sdk/test";
import { Effect, Exit, Fiber, Redacted, Schema } from "effect";

import { mkcertInstallPath } from "../src/provision.ts";
import {
  type CaHarness,
  FAKE_ROOT_PEM,
  MKCERT_BIN,
  failure,
  makeCa,
  makeCaHarness,
  makeFakeMkcertRunner,
  makeFakePrivilege,
  patchHostArtifact,
} from "./_fixtures.ts";

// mkcert's own name check (hostnameRegexp in mkcert's main.go); IP literals take its separate IP path.
const MKCERT_HOSTNAME = /^(\*\.)?[0-9a-z_-]([0-9a-z._-]*[0-9a-z_-])?$/iu;

test("every DNS certificate name Lando can request passes mkcert's hostname check", () => {
  let seed = 0x2057;
  const next = (bound: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 16) % bound;
  };
  const label = () => Array.from({ length: 1 + next(8) }, () => "aZ09_-x*"[next(8)]).join("");
  const names = Array.from(
    { length: 4000 },
    () => `${next(3) === 0 ? "*." : ""}${Array.from({ length: 1 + next(4) }, label).join(".")}`,
  ).filter((name) => Schema.is(CertificateName)(name) && !/^[0-9.]+$/u.test(name));
  expect(names.length).toBeGreaterThan(500);
  for (const name of names)
    expect({ name, accepted: MKCERT_HOSTNAME.test(name) }).toEqual({ name, accepted: true });
});

const SPEC = { cn: "web.app.internal", sans: ["web", "web.app.internal", "localhost", "127.0.0.1"] };

type Runner = ReturnType<typeof makeFakeMkcertRunner>;
const issuingCalls = (runner: Runner) => runner.calls().filter((call) => call.args.includes("-cert-file"));
const issuedDirectory = (runner: Runner) => {
  const args = issuingCalls(runner).at(-1)?.args ?? [];
  const certFile = args[args.indexOf("-cert-file") + 1];
  if (certFile === undefined) throw new Error("expected an issuing mkcert run");
  return dirname(certFile);
};
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const rootPath = (harness: CaHarness) => join(harness.caRoot, "rootCA.pem");

const withCa = async (
  options: Omit<Parameters<typeof makeFakeMkcertRunner>[0], "caRoot"> & { readonly arch?: string },
  body: (input: {
    readonly harness: CaHarness;
    readonly runner: Runner;
    readonly ca: ReturnType<typeof makeCa>["ca"];
    readonly downloadCalls: () => number;
  }) => Promise<void>,
) => {
  const harness = await makeCaHarness();
  const restore = patchHostArtifact(MKCERT_BIN);
  try {
    const { arch, ...runnerOptions } = options;
    const runner = makeFakeMkcertRunner({ caRoot: harness.caRoot, ...runnerOptions });
    const { ca, downloadCalls } = makeCa(harness, runner, arch === undefined ? {} : { arch });
    await body({ harness, runner, ca, downloadCalls });
  } finally {
    restore();
    await harness.cleanup();
  }
};

describe("mkcert CertificateAuthority setup", () => {
  test("provisions the binary, creates the root, and installs the local CA once", async () => {
    await withCa({}, async ({ harness, runner, ca }) => {
      await Effect.runPromise(ca.setup({ force: false }));

      const installedBinary = await readFile(mkcertInstallPath(harness.binDir, "linux"));
      expect(Array.from(installedBinary)).toEqual(Array.from(MKCERT_BIN));
      expect(await readFile(rootPath(harness), "utf8")).toBe(FAKE_ROOT_PEM);
      const installCalls = runner.calls().filter((call) => call.args[0] === "-install");
      expect(installCalls).toHaveLength(1);
      expect(installCalls[0]?.cmd).toBe(mkcertInstallPath(harness.binDir, "linux"));
      expect(installCalls[0]?.env?.CAROOT).toBe(harness.caRoot);
    });
  });

  test.each([
    { skipTrustInstall: false, installs: 1 },
    { skipTrustInstall: true, installs: 0 },
  ])(
    "creates a missing root with one throwaway issuance (skipTrustInstall=$skipTrustInstall)",
    async ({ skipTrustInstall, installs }) => {
      await withCa({}, async ({ harness, runner, ca }) => {
        // When
        await Effect.runPromise(ca.setup({ force: false, skipTrustInstall }));
        // Then: the root exists before any trust installation, and the throwaway leaf left nothing behind
        expect(await readFile(rootPath(harness), "utf8")).toBe(FAKE_ROOT_PEM);
        expect(issuingCalls(runner)).toHaveLength(1);
        expect(issuingCalls(runner)[0]?.env?.CAROOT).toBe(harness.caRoot);
        expect(await exists(issuedDirectory(runner))).toBe(false);
        expect(runner.calls().filter((call) => call.args[0] === "-install")).toHaveLength(installs);
        expect((await readdir(harness.caRoot)).sort()).toEqual(["rootCA.pem"]);
      });
    },
  );

  test.each([false, true])(
    "never touches an existing root (skipTrustInstall=%p)",
    async (skipTrustInstall) => {
      await withCa({}, async ({ harness, runner, ca }) => {
        // Given: CAROOT already holds a root
        await mkdir(harness.caRoot, { recursive: true });
        await writeFile(rootPath(harness), TEST_CERTIFICATES.rootA);
        const before = await stat(rootPath(harness));
        // When
        await Effect.runPromise(ca.setup({ force: false, skipTrustInstall }));
        // Then
        expect(issuingCalls(runner)).toEqual([]);
        expect(await readFile(rootPath(harness), "utf8")).toBe(TEST_CERTIFICATES.rootA);
        const after = await stat(rootPath(harness));
        expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
          ino: before.ino,
          mtimeMs: before.mtimeMs,
        });
      });
    },
  );

  test("skipTrustInstall provisions the binary without touching any trust store", async () => {
    await withCa({}, async ({ harness, runner, ca }) => {
      const privilege = makeFakePrivilege();
      await Effect.runPromise(
        ca.setup({ force: false, skipTrustInstall: true, privilege: privilege.service }),
      );
      await readFile(mkcertInstallPath(harness.binDir, "linux"));
      expect(runner.calls().filter((call) => call.args[0] === "-install")).toEqual([]);
      expect(privilege.calls()).toEqual([]);
    });
  });

  test("retries a failed trust-store install through PrivilegeService with the same CA root", async () => {
    await withCa({ installExitCode: 1 }, async ({ harness, ca }) => {
      const privilege = makeFakePrivilege();
      await Effect.runPromise(ca.setup({ force: false, privilege: privilege.service }));
      expect(privilege.calls()).toEqual([
        ["env", `CAROOT=${harness.caRoot}`, mkcertInstallPath(harness.binDir, "linux"), "-install"],
      ]);
    });
  });

  test("fails with actionable remediation when the trust-store install cannot be elevated", async () => {
    await withCa(
      { installExitCode: 1, installStderr: "permission denied writing to the system trust store" },
      async ({ ca }) => {
        const error = failure(await Effect.runPromiseExit(ca.setup({ force: false })));
        expect(error).toBeInstanceOf(CaError);
        expect((error as CaError).caId).toBe("mkcert");
        expect((error as CaError).message).toContain("permission denied writing to the system trust store");
        expect((error as CaError).message).toContain("--skip-install-ca");
      },
    );
  });

  test("fails with remediation on an unsupported host and never downloads", async () => {
    await withCa({ arch: "riscv64" }, async ({ runner, ca, downloadCalls }) => {
      const error = failure(await Effect.runPromiseExit(ca.setup({ force: false })));
      expect(error).toBeInstanceOf(CaError);
      expect((error as CaError).message).toContain("linux-riscv64");
      expect(downloadCalls()).toBe(0);
      expect(runner.calls()).toEqual([]);
    });
  });
});

describe("mkcert CertificateAuthority issuance", () => {
  test("issueCert returns the PEM mkcert wrote and keeps no copy", async () => {
    await withCa(
      { issue: { certificate: "leaf certificate PEM\n", privateKey: "leaf key PEM\n" } },
      async ({ harness, runner, ca }) => {
        await Effect.runPromise(ca.setup({ force: false, skipTrustInstall: true }));
        // When
        const issued = await Effect.runPromise(ca.issueCert(SPEC));
        // Then: the returned values are the files mkcert wrote, under the root it reports
        expect(issued.certificate).toBe("leaf certificate PEM\n");
        expect(Redacted.value(issued.privateKey)).toBe("leaf key PEM\n");
        expect(issued.root).toEqual({ certificate: FAKE_ROOT_PEM, trusted: false });
        expect(await Effect.runPromise(ca.root)).toEqual({ certificate: FAKE_ROOT_PEM, trusted: false });
        const issueCall = issuingCalls(runner).at(-1);
        expect(issueCall?.args.slice(5)).toEqual(["web", "web.app.internal", "localhost", "127.0.0.1"]);
        expect(issueCall?.env?.CAROOT).toBe(harness.caRoot);
        // And: its temporary directory is gone and nothing else was written beside the binary and CAROOT
        expect(await exists(issuedDirectory(runner))).toBe(false);
        expect((await readdir(harness.root)).sort()).toEqual(["bin", "caroot", "tool-downloads"]);
        expect(await readdir(harness.caRoot)).toEqual(["rootCA.pem"]);
      },
    );
  });

  test("removes its temporary directory when mkcert fails", async () => {
    await withCa({ issueExitCode: 1 }, async ({ harness, runner, ca }) => {
      await mkdir(harness.caRoot, { recursive: true });
      await writeFile(rootPath(harness), TEST_CERTIFICATES.rootA);
      await Effect.runPromise(ca.setup({ force: false, skipTrustInstall: true }));
      // When
      const error = failure(await Effect.runPromiseExit(ca.issueCert(SPEC)));
      // Then
      expect(error).toMatchObject({ _tag: "CaError", caId: "mkcert" });
      expect(issuingCalls(runner)).toHaveLength(1);
      expect(await exists(issuedDirectory(runner))).toBe(false);
    });
  });

  test("removes its temporary directory when issuance is interrupted", async () => {
    const issuing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await withCa(
      {
        afterIssue: async () => {
          issuing.resolve();
          await release.promise;
        },
      },
      async ({ harness, runner, ca }) => {
        await mkdir(harness.caRoot, { recursive: true });
        await writeFile(rootPath(harness), TEST_CERTIFICATES.rootA);
        await Effect.runPromise(ca.setup({ force: false, skipTrustInstall: true }));
        // Given: mkcert has written the pair and not yet exited
        const fiber = Effect.runFork(ca.issueCert(SPEC));
        await issuing.promise;
        expect(await exists(issuedDirectory(runner))).toBe(true);
        // When
        const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
        release.resolve();
        await interrupted;
        // Then
        expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(fiber)))).toBe(true);
        expect(await exists(issuedDirectory(runner))).toBe(false);
      },
    );
  });

  test.each(["root", "issueCert"] as const)(
    "%s before setup states the missing binary, runs no mkcert command, and creates no root",
    async (operation) => {
      await withCa({}, async ({ harness, runner, ca }) => {
        const effect: Effect.Effect<unknown, CaError> = operation === "root" ? ca.root : ca.issueCert(SPEC);
        const error = failure(await Effect.runPromiseExit(effect));
        expect(error).toMatchObject({ _tag: "CaError", caId: "mkcert" });
        expect(error.remediation).toContain("`lando setup`");
        expect(error.message).toContain(mkcertInstallPath(harness.binDir, "linux"));
        expect(runner.calls()).toEqual([]);
        expect(await exists(rootPath(harness))).toBe(false);
      });
    },
  );

  test.each(["root", "issueCert"] as const)(
    "%s without a root fails with setup remediation and never creates one",
    async (operation) => {
      await withCa({}, async ({ harness, runner, ca }) => {
        // Given: the binary is installed but CAROOT has no root
        await Effect.runPromise(ca.setup({ force: false, skipTrustInstall: true }));
        await rm(rootPath(harness));
        const before = issuingCalls(runner).length;
        // When
        const effect: Effect.Effect<unknown, CaError> = operation === "root" ? ca.root : ca.issueCert(SPEC);
        const error = failure(await Effect.runPromiseExit(effect));
        // Then
        expect(error).toMatchObject({ _tag: "CaError", caId: "mkcert" });
        expect(error.remediation).toContain("`lando setup`");
        expect(issuingCalls(runner)).toHaveLength(before);
        expect(await exists(rootPath(harness))).toBe(false);
      });
    },
  );

  test.each([
    { cn: "-uninstall", sans: ["-cert-file", "/tmp/overwrite.pem", "-key-file"] },
    { cn: "app.lndo.site", sans: ["*-app.lndo.site"] },
    { cn: "app.lndo.site", sans: ["wild.*.app.lndo.site"] },
  ])("rejects names that are not certificate names before running mkcert (%j)", async (spec) => {
    await withCa({}, async ({ runner, ca }) => {
      await Effect.runPromise(ca.setup({ force: false, skipTrustInstall: true }));
      const before = runner.calls().length;

      const error = failure(await Effect.runPromiseExit(ca.issueCert(spec)));

      expect(error).toBeInstanceOf(CaError);
      expect(runner.calls()).toHaveLength(before);
    });
  });

  test("satisfies the CertificateAuthority contract suite", async () => {
    await withCa({ issue: TEST_CERTIFICATES.contract }, async ({ harness, ca }) => {
      // Real leaf material under the root CAROOT holds.
      await mkdir(harness.caRoot, { recursive: true });
      await writeFile(rootPath(harness), TEST_CERTIFICATES.rootA);
      await Effect.runPromise(ca.setup({ force: false, skipTrustInstall: true }));

      const exit = await Effect.runPromiseExit(runCaContract(ca));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(ca.id).toBe("mkcert");
    });
  });
});
