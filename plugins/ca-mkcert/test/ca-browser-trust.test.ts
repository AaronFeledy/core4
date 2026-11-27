import { describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect } from "effect";

import {
  type CaHarness,
  MKCERT_BIN,
  makeCa,
  makeCaHarness,
  makeFakeMkcertRunner,
  patchHostArtifact,
} from "./_fixtures.ts";
import { type FakeCertutil, makeFakeCertutil } from "./support/fake-certutil.ts";

const { rootA, rootB } = TEST_CERTIFICATES;

const withBrowserDatabase = async (
  body: (input: {
    readonly harness: CaHarness;
    readonly certutil: FakeCertutil;
    readonly ca: ReturnType<typeof makeCa>["ca"];
    readonly nssdb: string;
    readonly systemBundle: string;
  }) => Promise<void>,
) => {
  const harness = await makeCaHarness();
  const restore = patchHostArtifact(MKCERT_BIN);
  try {
    const home = join(harness.root, "home");
    const nssdb = join(home, ".pki", "nssdb");
    const bin = join(harness.root, "path");
    const systemBundle = join(harness.root, "system.pem");
    await mkdir(nssdb, { recursive: true });
    await mkdir(bin, { recursive: true });
    for (const tool of ["certutil", "certutil.exe"]) {
      await writeFile(join(bin, tool), "");
      await chmod(join(bin, tool), 0o755);
    }
    await writeFile(join(harness.root, "WSLInterop"), "enabled\n");
    await writeFile(systemBundle, rootA);
    await mkdir(harness.caRoot, { recursive: true });
    await writeFile(join(harness.caRoot, "rootCA.pem"), rootA);
    const mkcert = makeFakeMkcertRunner({ caRoot: harness.caRoot });
    const certutil = makeFakeCertutil(
      { [nssdb]: [{ nickname: "Other", trust: "C,,", pem: rootB }] },
      {
        fallback: {
          ...mkcert.service,
          // Windows never holds the root; wslpath converts the path.
          run: (input) =>
            input.cmd.endsWith("certutil.exe")
              ? Effect.succeed({ exitCode: 17, stdout: "", stderr: "" })
              : input.cmd === "wslpath"
                ? Effect.succeed({ exitCode: 0, stdout: "C:\\rootCA.pem\n", stderr: "" })
                : mkcert.service.run(input),
        },
      },
    );
    const { ca } = makeCa(
      harness,
      { service: certutil.service, calls: mkcert.calls },
      {
        env: { HOME: home, PATH: bin },
        linuxSystemBundles: [systemBundle],
        windowsTrustPaths: {
          interop: [join(harness.root, "WSLInterop")],
          certutil: join(harness.root, "none.exe"),
        },
      },
    );
    await body({ harness, certutil, ca, nssdb, systemBundle });
  } finally {
    restore();
    await harness.cleanup();
  }
};

describe("mkcert CertificateAuthority browser trust", () => {
  test("setup writes the browser database, reports stores in order, and a rerun writes nothing", async () => {
    await withBrowserDatabase(async ({ certutil, ca, nssdb, systemBundle }) => {
      const first = await Effect.runPromise(ca.setup({ force: false }));
      expect(first.trustStores.map(({ id, state, changed }) => ({ id, state, changed }))).toEqual([
        { id: "system", state: "trusted", changed: false },
        { id: "nss", state: "trusted", changed: true },
        { id: "windows", state: "untrusted", changed: false },
      ]);
      expect(first.trustStores[0]?.location).toBe(systemBundle);
      expect(first.trustStores[1]).toMatchObject({
        location: nssdb,
        detail: "Restart Chrome or Chromium to use it.",
      });
      expect(certutil.entries(nssdb)?.map(({ nickname, trust }) => ({ nickname, trust }))).toEqual([
        { nickname: "Other", trust: "C,," },
        { nickname: "mkcert development CA 4096", trust: "C,," },
      ]);
      const writes = () => certutil.calls().filter(({ args }) => args[0] === "-A");
      expect(writes()).toHaveLength(1);

      const second = await Effect.runPromise(ca.setup({ force: false }));
      expect(second.trustStores.map(({ changed }) => changed)).toEqual([false, false, false]);
      expect(writes()).toHaveLength(1);
      // trustStores reads the same stores without writing.
      expect(await Effect.runPromise(ca.trustStores)).toEqual(
        second.trustStores.map(({ changed: _, ...row }) => row),
      );
      expect(writes()).toHaveLength(1);
    });
  });

  test("setup with skipTrustInstall reports the missing database without writing it", async () => {
    await withBrowserDatabase(async ({ certutil, ca }) => {
      const result = await Effect.runPromise(ca.setup({ force: false, skipTrustInstall: true }));
      expect(result.trustStores[1]).toMatchObject({ id: "nss", state: "untrusted", reason: "missing" });
      expect(certutil.calls().filter(({ args }) => args[0] === "-A")).toEqual([]);
    });
  });
});
