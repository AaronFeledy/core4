import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Context, Effect, Layer, Schema, Stream } from "effect";

import { MKCERT_TOOL_VERSION, mkcertInstallPath, mkcertInstalledVersionPath } from "@lando/ca-mkcert";
import { AbsolutePath, LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, ProcessRunner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

test("bundled mkcert setup issues certs through the production app planner", async () => {
  // Given: isolated roots containing a fingerprinted, preinstalled fake mkcert.
  const root = await mkdtemp(join(tmpdir(), "lando-ca-production-path-"));
  const appRoot = join(root, "app");
  const userConfRoot = join(root, "config");
  const userCacheRoot = join(root, "cache");
  const userDataRoot = join(root, "data");
  const systemPluginRoot = join(root, "system-plugins");
  const binDir = join(userDataRoot, "bin");
  const certsDir = join(userDataRoot, "certs");
  const caRoot = join(userDataRoot, "ca");
  const binaryPath = mkcertInstallPath(binDir);
  const certPath = join(certsDir, "web.production-certs.internal.pem");
  const keyPath = join(certsDir, "web.production-certs.internal-key.pem");
  const caPath = join(caRoot, "rootCA.pem");
  const setupMarker = join(root, "mkcert-trust-installed");
  const fakeMkcert = "cross-platform fake mkcert binary";
  const processRunner = {
    run: (input) =>
      Effect.promise(async () => {
        if (input.cmd !== binaryPath) {
          return { exitCode: 2, stdout: "", stderr: `unexpected command: ${input.cmd}` };
        }
        if (input.args[0] === "-CAROOT") {
          await mkdir(caRoot, { recursive: true });
          await writeFile(caPath, "fake root certificate\n");
          return { exitCode: 0, stdout: `${caRoot}\n`, stderr: "" };
        }
        if (input.args[0] === "-install") {
          if (input.env?.CAROOT !== caRoot) {
            return { exitCode: 2, stdout: "", stderr: "mkcert install requires the resolved CAROOT" };
          }
          await writeFile(setupMarker, "trust installed\n");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const certIndex = input.args.indexOf("-cert-file");
        const keyIndex = input.args.indexOf("-key-file");
        const issuedCertPath = certIndex < 0 ? undefined : input.args[certIndex + 1];
        const issuedKeyPath = keyIndex < 0 ? undefined : input.args[keyIndex + 1];
        if (issuedCertPath === undefined || issuedKeyPath === undefined) {
          return { exitCode: 2, stdout: "", stderr: `unexpected arguments: ${input.args.join(" ")}` };
        }
        await writeFile(issuedCertPath, "fake leaf certificate\n");
        await writeFile(issuedKeyPath, "fake leaf private key\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    stream: () => Stream.empty,
  } satisfies Context.Tag.Service<typeof ProcessRunner>;

  try {
    await mkdir(appRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(binaryPath, fakeMkcert);
    await writeFile(mkcertInstalledVersionPath(binDir), `${MKCERT_TOOL_VERSION}\n`);
    await writeFile(`${binaryPath}.sha256`, `${createHash("sha256").update(fakeMkcert).digest("hex")}\n`);

    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "production-certs",
      runtime: 4,
      services: { web: { type: "node:22", certs: true } },
    });

    // When: the real app runtime resolves and sets up bundled mkcert, then plans certs: true.
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            makeLandoRuntime({
              bootstrap: "app",
              cwd: appRoot,
              plugins: {
                policy: "bundled-only",
                layers: [Layer.succeed(ProcessRunner, processRunner)],
              },
              config: {
                userConfRoot: AbsolutePath.make(userConfRoot),
                userCacheRoot: AbsolutePath.make(userCacheRoot),
                userDataRoot: AbsolutePath.make(userDataRoot),
                systemPluginRoot: AbsolutePath.make(systemPluginRoot),
              },
            }),
          );
          const authority = yield* Context.get(context, CertificateAuthorityResolver).resolve;
          yield* authority.setup({ force: false });
          const plan = yield* Context.get(context, AppPlanner).plan(
            rememberLandofileAppRoot(landofile, appRoot),
            TestRuntimeProvider.capabilities,
          );
          return { authorityId: authority.id, plan };
        }),
      ),
    );

    // Then: selection, issued files, CA material, and service plan metadata are production-shaped.
    expect(result.authorityId).toBe("mkcert");
    expect(await readFile(setupMarker, "utf8")).toBe("trust installed\n");
    expect(await readFile(certPath, "utf8")).toBe("fake leaf certificate\n");
    expect(await readFile(keyPath, "utf8")).toBe("fake leaf private key\n");
    expect(await readFile(caPath, "utf8")).toBe("fake root certificate\n");

    const web = result.plan.services[ServiceName.make("web")];
    expect(web?.certs).toEqual({
      cn: "web.production-certs.internal",
      sans: [
        "web",
        "web.production-certs.internal",
        "web.production-certs.lndo.site",
        "localhost",
        "127.0.0.1",
      ],
      caId: "mkcert",
    });
    expect(web?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/web.crt");
    expect(web?.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/web.key");
    expect(web?.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: certPath,
          target: "/etc/lando/certs/leaf/web.crt",
          readOnly: true,
        }),
        expect.objectContaining({ source: keyPath, target: "/etc/lando/certs/leaf/web.key", readOnly: true }),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
