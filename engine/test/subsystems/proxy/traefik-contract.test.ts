import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { makeTraefikRouterService } from "@lando/proxy-traefik";
import { AppId, ServiceName } from "@lando/sdk/schema";
import { type CertificateAuthorityShape, FileSystem } from "@lando/sdk/services";
import { makeTestCertificateAuthority, runRouterServiceContractSuite } from "@lando/sdk/test";
import { FileSystemLive } from "../../../src/services/file-system.ts";

test("bundled Traefik satisfies the RouterService contract suite", async () => {
  const files = new Map<string, string>();
  const service = makeTraefikRouterService({
    certificateAuthority: makeTestCertificateAuthority(),
    fileSystem: {
      mkdir: () => Effect.void,
      exists: (path) =>
        Effect.succeed(files.has(path) || path.endsWith("/dynamic") || path.endsWith("/certs")),
      readDir: (path) =>
        Effect.succeed(
          [...files.keys()]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1)),
        ),
      readText: (path) => Effect.succeed(files.get(path) ?? ""),
      writeAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      writeSecretAtomic: (path, content) => Effect.sync(() => void files.set(path, String(content))),
      remove: (path) => Effect.sync(() => void files.delete(path)),
    },
    paths: { platform: "linux", globalAppRoot: "/lando/global" },
    globalApp: {
      ensureRunning: () =>
        Effect.succeed([
          {
            name: "traefik",
            state: "running",
            endpoints: ["http://127.0.0.1:38080", "https://127.0.0.1:38443"],
          },
        ]),
    },
  });

  await Effect.runPromise(
    runRouterServiceContractSuite({
      service,
      readRoutes: service.readAppliedRoutes,
    }),
  );

  expect(files.size).toBe(0);
});

test("real filesystem status sees configured routing and stop removes route and certificate artifacts", async () => {
  // Given: a configured proxy whose routes and TLS material live on FileSystemLive.
  const root = await mkdtemp(join(tmpdir(), "lando-proxy-lifecycle-"));
  try {
    const sourceCert = join(root, "issued.crt");
    const sourceKey = join(root, "issued.key");
    await writeFile(sourceCert, "certificate");
    await writeFile(sourceKey, "private key");
    const certificateAuthority: CertificateAuthorityShape = {
      id: "real-filesystem-ca",
      setup: () => Effect.void,
      issueCert: () => Effect.succeed({ certPath: sourceCert, keyPath: sourceKey, caPath: sourceCert }),
    };
    const fileSystem = await Effect.runPromise(FileSystem.pipe(Effect.provide(FileSystemLive)));
    const proxyFileSystem = {
      mkdir: fileSystem.mkdir,
      exists: fileSystem.exists,
      readDir: fileSystem.readDir,
      readText: fileSystem.readText,
      writeAtomic: fileSystem.writeAtomic,
      writeSecretAtomic: fileSystem.writeAtomic,
      remove: fileSystem.remove,
    };
    const service = makeTraefikRouterService({
      certificateAuthority,
      fileSystem: proxyFileSystem,
      paths: { platform: "linux", globalAppRoot: root },
      globalApp: {
        ensureRunning: () =>
          Effect.succeed([
            {
              name: "traefik",
              state: "running",
              endpoints: ["http://127.0.0.1:38080", "https://127.0.0.1:38443"],
            },
          ]),
      },
    });
    const app = AppId.make("real-filesystem");
    await Effect.runPromise(Effect.scoped(service.setup({ defaultDomain: "lndo.site" })));
    await Effect.runPromise(
      service.applyRoutes(
        [
          {
            hostname: "real-filesystem.lndo.site",
            scheme: "https",
            service: ServiceName.make("web"),
            backend: { service: ServiceName.make("web"), protocol: "http", port: 8080 },
          },
        ],
        app,
      ),
    );

    // When: a fresh service reads status and the active service is stopped.
    const fresh = makeTraefikRouterService({
      certificateAuthority,
      fileSystem: proxyFileSystem,
      paths: { platform: "linux", globalAppRoot: root },
      globalApp: { ensureRunning: () => Effect.succeed([]) },
    });
    const status = await Effect.runPromise(fresh.status);
    await Effect.runPromise(service.stop);

    // Then: persisted routing was visible and every route/certificate artifact is gone.
    expect(status.state).toBe("running");
    expect(status.configuredApps).toEqual([app]);
    const dynamic = join(root, "proxy-traefik", "dynamic");
    expect(await fileSystem.exists(join(dynamic, "routes-real-filesystem.yml")).pipe(Effect.runPromise)).toBe(
      false,
    );
    expect(await fileSystem.exists(join(dynamic, "tls-default.yml")).pipe(Effect.runPromise)).toBe(false);
    expect(
      await fileSystem.exists(join(dynamic, "certs", "real-filesystem.crt")).pipe(Effect.runPromise),
    ).toBe(false);
    expect(
      await fileSystem.exists(join(dynamic, "certs", "real-filesystem.key")).pipe(Effect.runPromise),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
