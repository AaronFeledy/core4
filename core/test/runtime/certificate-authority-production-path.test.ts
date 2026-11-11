import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MKCERT_TOOL_VERSION, mkcertInstallPath, mkcertInstalledVersionPath } from "@lando/ca-mkcert";
import { prepareServiceCertificates } from "@lando/engine/lifecycle/service-certificates";
import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import { AbsolutePath, LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, ProcessRunner } from "@lando/sdk/services";
import { TEST_CERTIFICATES, TestRuntimeProvider } from "@lando/sdk/test";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { literalLandofile } from "../_support/value-contracts.ts";

test("bundled mkcert issues certs when the production runtime prepares a plan, never while planning", async () => {
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
  const issuances: string[] = [];
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  const caPath = join(caRoot, "rootCA.pem");
  const setupMarker = join(root, "mkcert-trust-installed");
  const fakeMkcert = "cross-platform fake mkcert binary";
  const processRunner = ProcessRunner.of({
    run: (input) =>
      Effect.promise(async () => {
        if (input.cmd !== binaryPath) {
          return { exitCode: 2, stdout: "", stderr: `unexpected command: ${input.cmd}` };
        }
        // Like mkcert, -CAROOT only reports the directory and an issuing run creates a missing root.
        if (input.args[0] === "-CAROOT") return { exitCode: 0, stdout: `${caRoot}\n`, stderr: "" };
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
        issuances.push(issuedCertPath);
        if (input.env?.CAROOT !== caRoot) {
          return { exitCode: 2, stdout: "", stderr: "mkcert issuance requires the resolved CAROOT" };
        }
        if (!(await exists(caPath))) {
          await mkdir(caRoot, { recursive: true });
          await writeFile(caPath, TEST_CERTIFICATES.rootA);
        }
        await writeFile(issuedCertPath, TEST_CERTIFICATES.serviceExtraName.certificate);
        await writeFile(issuedKeyPath, TEST_CERTIFICATES.serviceExtraName.privateKey);
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    stream: () => Stream.empty,
    streamWithExit: () => Stream.empty,
  } satisfies Context.Service.Shape<typeof ProcessRunner>);

  try {
    await mkdir(appRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(binaryPath, fakeMkcert);
    await writeFile(mkcertInstalledVersionPath(binDir), `${MKCERT_TOOL_VERSION}\n`);
    await writeFile(`${binaryPath}.sha256`, `${createHash("sha256").update(fakeMkcert).digest("hex")}\n`);

    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "app",
      runtime: 4,
      services: { web: { type: "node:22", certs: true } },
    });

    // When: the real app runtime sets up bundled mkcert, plans certs: true, then prepares the plan.
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
          const issuedBySetup = issuances.length;
          const plan = yield* Context.get(context, AppPlanner).plan(
            literalLandofile(landofile, appRoot),
            TestRuntimeProvider.capabilities,
          );
          const issuedWhilePlanning = issuances.length - issuedBySetup;
          const prepared = yield* prepareServiceCertificates(plan).pipe(Effect.provide(context));
          return { authorityId: authority.id, plan, prepared, issuedWhilePlanning };
        }),
      ),
    );

    // Then: selection, issued files, CA material, and service plan metadata are production-shaped.
    expect(result.authorityId).toBe("mkcert");
    expect(await readFile(setupMarker, "utf8")).toBe("trust installed\n");
    expect(result.issuedWhilePlanning).toBe(0);
    // Setup needs one throwaway issuance to create the root; preparation needs the service leaf.
    expect(issuances).toHaveLength(2);
    for (const issued of issuances) {
      expect(issued.startsWith(userDataRoot)).toBe(false);
      expect(await exists(dirname(issued))).toBe(false);
    }
    expect(await exists(join(certsDir, "issued"))).toBe(false);
    expect(await readFile(caPath, "utf8")).toBe(TEST_CERTIFICATES.rootA);

    const web = result.plan.services[ServiceName.make("web")];
    expect(web?.certs).toEqual({
      cn: "web.app.internal",
      sans: ["web", "web.app.internal", "web.app.lndo.site", "localhost", "127.0.0.1"],
      caId: "mkcert",
    });
    expect(web?.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/web.crt");
    expect(web?.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/web.key");
    const leafMounts = (result.prepared.services[ServiceName.make("web")]?.mounts ?? []).flatMap((mount) =>
      mount.type === "bind" && mount.target.startsWith("/etc/lando/certs/leaf/") ? [mount] : [],
    );
    expect(leafMounts.map((mount) => String(mount.target))).toEqual([
      "/etc/lando/certs/leaf/web.crt",
      "/etc/lando/certs/leaf/web.key",
    ]);
    const [certMount, keyMount] = leafMounts;
    if (certMount === undefined || keyMount === undefined) throw new Error("expected both leaf binds");
    expect(certMount.source.startsWith(join(certsDir, "services"))).toBe(true);
    expect(await readFile(certMount.source, "utf8")).toBe(TEST_CERTIFICATES.serviceExtraName.certificate);
    expect(await readFile(keyMount.source, "utf8")).toBe(TEST_CERTIFICATES.serviceExtraName.privateKey);
    const identity = createHash("sha256")
      .update(TEST_CERTIFICATES.serviceExtraName.certificate)
      .digest("hex");
    expect(
      leafMounts.map((mount) => ({
        createHostPath: mount.createHostPath,
        sourceIdentity: mount.sourceIdentity,
      })),
    ).toEqual([
      { createHostPath: false, sourceIdentity: identity },
      { createHostPath: false, sourceIdentity: identity },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
