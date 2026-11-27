import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostChangeFailedError } from "@lando/sdk/errors";
import type { HostChange } from "@lando/sdk/schema";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect, Exit } from "effect";

import { mkcertInstallPath } from "../src/provision.ts";
import { rootPemProblem } from "../src/system-store-change.ts";
import { TRUST_SYSTEM_STORE } from "../src/system-store-declaration.ts";
import {
  type CaHarness,
  DEBIAN_ANCHOR,
  DEBIAN_REFRESH,
  MKCERT_BIN,
  approveCaChanges,
  debianHost,
  failure,
  makeCa,
  makeCaHarness,
  makeFakeMkcertRunner,
  makeFakeSession,
  okResult,
  patchHostArtifact,
} from "./_fixtures.ts";

const { rootA, rootB } = TEST_CERTIFICATES;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Runner = ReturnType<typeof makeFakeMkcertRunner>;

/**
 * A host whose mkcert `CAROOT` holds `root` (none when undefined) and whose system bundle holds
 * `system`. The session's store refresh writes `systemAfterTrust` into that bundle, as the real
 * refresh rebuilds it from the anchors.
 */
const withHost = async (
  options: {
    readonly platform?: string;
    readonly root?: string;
    readonly system?: string;
    readonly systemAfterTrust?: string;
    readonly exists?: (path: string) => boolean;
    readonly afterInstall?: () => Promise<void>;
  },
  body: (input: {
    readonly harness: CaHarness;
    readonly runner: Runner;
    readonly ca: ReturnType<typeof makeCa>["ca"];
    readonly session: ReturnType<typeof makeFakeSession>;
    readonly plan: () => Promise<ReadonlyArray<HostChange>>;
  }) => Promise<void>,
) => {
  const harness = await makeCaHarness();
  const restore = patchHostArtifact(MKCERT_BIN, options.platform === "win32" ? "win32-x64" : undefined);
  try {
    const bundle = join(harness.root, "system.pem");
    if (options.system !== undefined) await writeFile(bundle, options.system);
    if (options.root !== undefined) {
      await mkdir(harness.caRoot, { recursive: true });
      await writeFile(join(harness.caRoot, "rootCA.pem"), options.root);
    }
    const runner = makeFakeMkcertRunner({
      caRoot: harness.caRoot,
      ...(options.afterInstall === undefined ? {} : { afterInstall: options.afterInstall }),
    });
    const { ca } = makeCa(harness, runner, {
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      env: { CAROOT: harness.caRoot, PATH: "" },
      linuxSystemBundles: [bundle],
      exists: options.exists ?? debianHost,
    });
    const session = makeFakeSession(async ([command]) => {
      if (command === DEBIAN_REFRESH && options.systemAfterTrust !== undefined)
        await writeFile(bundle, options.systemAfterTrust);
      return okResult();
    });
    const plan = () =>
      Effect.runPromise(ca.planHostChanges ?? Effect.succeed([])).then((proposals) =>
        proposals.map(({ change }) => change),
      );
    await body({ harness, runner, ca, session, plan });
  } finally {
    restore();
    await harness.cleanup();
  }
};

describe("checking the root before it reaches a trust store", () => {
  test.each([
    ["one CA certificate", rootA, undefined],
    ["two certificates", `${rootA}\n${rootB}`, "it holds 2 certificates instead of one"],
    ["a leaf certificate", TEST_CERTIFICATES.contract.certificate, "it is not a CA certificate"],
    ["text that is not a certificate", "not a certificate", "it holds 0 certificates instead of one"],
    [
      "a certificate block that does not parse",
      "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n",
      "it is not a readable X.509 certificate",
    ],
  ])("%s", (_name, pem, problem) => {
    expect(rootPemProblem(pem)).toBe(problem);
  });
});

describe("planning system-store trust", () => {
  test("Linux plans fixed root commands that read the certificate from stdin, and runs nothing", async () => {
    await withHost({ root: rootA, system: rootB }, async ({ plan, runner, session, harness }) => {
      const [change, ...rest] = await plan();

      expect(rest).toEqual([]);
      expect(change).toMatchObject({
        id: TRUST_SYSTEM_STORE,
        owner: "@lando/ca-mkcert",
        stage: "ca",
        consent: "standard",
        requirement: "recommended",
        persistent: false,
        details: { anchor: DEBIAN_ANCHOR, sha256: sha256(rootA) },
      });
      expect(
        change?.steps.map(({ id, argv, privileged, stdin }) => ({ id, argv, privileged, stdin })),
      ).toEqual([
        {
          id: "write-anchor",
          argv: ["/usr/bin/tee", DEBIAN_ANCHOR],
          privileged: true,
          stdin: { summary: "The local CA certificate (never its private key)", sha256: sha256(rootA) },
        },
        {
          id: "chmod-anchor",
          argv: ["/usr/bin/chmod", "0644", DEBIAN_ANCHOR],
          privileged: true,
          stdin: undefined,
        },
        { id: "refresh", argv: [DEBIAN_REFRESH], privileged: true, stdin: undefined },
      ]);
      // No root step opens its input by path; a person runs the manual form with their own copy.
      expect(change?.steps.flatMap(({ argv }) => argv)).not.toContain("/dev/stdin");
      expect(change?.manual).toBe(
        `sudo install -m 0644 ${harness.caRoot}/rootCA.pem ${DEBIAN_ANCHOR} && sudo ${DEBIAN_REFRESH}`,
      );
      expect(change?.undo).toMatchObject({
        _tag: "steps",
        consent: "separate",
        steps: [{ argv: ["/usr/bin/rm", "-f", "--", DEBIAN_ANCHOR] }, { argv: [DEBIAN_REFRESH] }],
      });
      expect(runner.calls()).toEqual([]);
      expect(session.elevations()).toEqual([]);
    });
  });

  test("plans the change before setup creates a root, binding its input at apply by a stated check", async () => {
    await withHost({ system: rootB }, async ({ plan }) => {
      const [change] = await plan();
      expect(change?.steps[0]?.stdin).toEqual({
        summary: "The local CA certificate (never its private key)",
        boundAt: "apply",
        verifiedBy:
          "the root setup creates first, piped only if it is exactly one PEM certificate that parses as X.509 and is a CA (CA:TRUE)",
      });
      expect(change?.details).toEqual({ anchor: DEBIAN_ANCHOR });
    });
  });

  test.each([
    ["the system store already trusts the root", { root: rootA, system: `${rootB}\n${rootA}` }],
    ["the host has no anchor store Lando knows", { root: rootA, system: rootB, exists: () => false }],
  ])("plans nothing when %s", async (_name, options) => {
    await withHost(options, async ({ plan }) => {
      expect(await plan()).toEqual([]);
    });
  });

  test("macOS stages the certificate in a root-owned directory and trusts that copy", async () => {
    await withHost({ platform: "darwin", root: rootA }, async ({ plan }) => {
      const [change] = await plan();
      const staged = "/Library/Application Support/Lando/local-ca.pem";
      expect(change?.steps.map(({ argv }) => argv)).toEqual([
        ["/bin/mkdir", "-p", "/Library/Application Support/Lando"],
        ["/usr/bin/tee", staged],
        [
          "/usr/bin/security",
          "add-trusted-cert",
          "-d",
          "-r",
          "trustRoot",
          "-k",
          "/Library/Keychains/System.keychain",
          staged,
        ],
      ]);
      expect(change?.steps[1]?.stdin?.sha256).toBe(sha256(rootA));
      expect(change?.reason).toContain("desktop session");
    });
  });

  test("native Windows runs mkcert -install as the user for the user's store", async () => {
    await withHost({ platform: "win32", root: rootA }, async ({ plan, harness }) => {
      const [change] = await plan();
      expect(change?.steps).toEqual([
        {
          id: "install",
          summary: "Add the CA to your Windows Root store",
          argv: [mkcertInstallPath(harness.binDir, "win32"), "-install"],
          privileged: false,
          env: { CAROOT: harness.caRoot, TRUST_STORES: "system" },
          when: "always",
        },
      ]);
      expect(change?.undo._tag).toBe("manual");
    });
  });
});

describe("planning with a corrupt root", () => {
  const corrupt = "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n";

  test.each(["linux", "darwin", "win32"] as const)(
    "%s plans the change and notes the problem, leaving the refusal to apply",
    async (platform) => {
      await withHost({ platform, root: corrupt }, async ({ plan, harness }) => {
        const [change] = await plan();

        expect(change?.id).toBe(TRUST_SYSTEM_STORE);
        expect(change?.reason).toContain(
          `${harness.caRoot}/rootCA.pem cannot be trusted as it is, because it is not a readable X.509 certificate`,
        );
        expect(change?.details?.problem).toContain("it is not a readable X.509 certificate");
        // No undo names a certificate that could not be read.
        expect(JSON.stringify(change?.undo)).not.toContain("delete-certificate");
      });
    },
  );
});

describe("applying system-store trust", () => {
  test("pipes the verified root to the planned commands and reports the store changed", async () => {
    await withHost(
      { root: rootA, system: rootB, systemAfterTrust: `${rootB}\n${rootA}` },
      async ({ ca, runner, session }) => {
        const hostChanges = await approveCaChanges(ca, session.session);

        const { trustStores } = await Effect.runPromise(ca.setup({ force: false, hostChanges }));

        expect(session.elevations()).toEqual([
          { argv: ["/usr/bin/tee", DEBIAN_ANCHOR], stdin: rootA },
          { argv: ["/usr/bin/chmod", "0644", DEBIAN_ANCHOR] },
          { argv: [DEBIAN_REFRESH] },
        ]);
        expect(trustStores[0]).toMatchObject({ id: "system", state: "trusted", changed: true });
        expect(runner.calls().filter(({ args }) => args[0] === "-install")).toEqual([]);
      },
    );
  });

  test("leaves the store alone when the run did not approve the change", async () => {
    await withHost({ root: rootA, system: rootB }, async ({ ca, session }) => {
      const { trustStores } = await Effect.runPromise(ca.setup({ force: false }));
      expect(session.elevations()).toEqual([]);
      expect(trustStores[0]).toMatchObject({ id: "system", state: "untrusted", changed: false });
    });
  });

  test("refuses a root that is not one CA certificate before root runs anything", async () => {
    await withHost({ root: `${rootA}\n${rootB}`, system: rootB }, async ({ ca, session }) => {
      const hostChanges = await approveCaChanges(ca, session.session);

      const error = failure(await Effect.runPromiseExit(ca.setup({ force: false, hostChanges })));

      expect(error).toBeInstanceOf(HostChangeFailedError);
      expect(error).toMatchObject({ changeId: TRUST_SYSTEM_STORE });
      expect(error.message).toContain("2 certificates");
      expect(session.elevations()).toEqual([]);
    });
  });

  test("runs nothing when the root changed after planning, and setup still finishes", async () => {
    await withHost({ root: rootA, system: rootB }, async ({ ca, harness, session }) => {
      const hostChanges = await approveCaChanges(ca, session.session);
      await writeFile(join(harness.caRoot, "rootCA.pem"), rootB);

      const exit = await Effect.runPromiseExit(ca.setup({ force: false, hostChanges }));

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(session.elevations()).toEqual([]);
    });
  });

  test("a failed anchor write fails setup with the command's report", async () => {
    await withHost({ root: rootA, system: rootB }, async ({ ca }) => {
      const refused = makeFakeSession(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "read-only file system",
      }));
      const hostChanges = await approveCaChanges(ca, refused.session);

      const error = failure(await Effect.runPromiseExit(ca.setup({ force: false, hostChanges })));

      expect(error).toMatchObject({ _tag: "HostChangeFailedError", stepId: "write-anchor", exitCode: 1 });
      expect(error.message).toContain("read-only file system");
      expect(refused.elevations()).toHaveLength(1);
    });
  });

  test("native Windows runs the planned mkcert -install unprivileged", async () => {
    await withHost({ platform: "win32", root: rootA }, async ({ ca, runner, session }) => {
      const hostChanges = await approveCaChanges(ca, session.session, runner.service);

      await Effect.runPromise(ca.setup({ force: false, hostChanges }));

      expect(session.elevations()).toEqual([]);
      expect(runner.calls().filter(({ args }) => args[0] === "-install")).toEqual([
        expect.objectContaining({ env: expect.objectContaining({ TRUST_STORES: "system" }) }),
      ]);
    });
  });
});
