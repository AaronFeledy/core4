import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { type ContainerBuildHttpRequest, buildContainerArtifact } from "@lando/container-runtime/image-build";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("docker");
const appId = AppId.make("ca-build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-30T00:00:00Z"),
  source: "image-build-ca.test.ts",
  runtime: 4 as const,
};
const trustStoreCommand =
  "set -e; mkdir -p /etc/lando/certs; if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; elif command -v update-ca-trust >/dev/null 2>&1; then mkdir -p /etc/pki/ca-trust/source/anchors && cp /usr/local/share/ca-certificates/lando-*.crt /etc/pki/ca-trust/source/anchors/ && update-ca-trust extract; else echo 'No supported CA trust-store installer found.' >&2; exit 1; fi; cat /usr/local/share/ca-certificates/lando-*.crt > /etc/lando/certs/ca-bundle.pem";

type TarEntry = { readonly name: string; readonly mode: number; readonly content: Uint8Array };

const collect = async (input: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  if (input !== undefined) for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const tarEntries = (archive: Uint8Array): ReadonlyArray<TarEntry> => {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stringAt = (start: number, end: number): string =>
      new TextDecoder().decode(header.subarray(start, end)).replace(/\0.*$/u, "");
    const size = Number.parseInt(stringAt(124, 136).trim() || "0", 8);
    const contentOffset = offset + 512;
    entries.push({
      name: stringAt(0, 100),
      mode: Number.parseInt(stringAt(100, 108).trim() || "0", 8),
      content: archive.subarray(contentOffset, contentOffset + size),
    });
    offset = contentOffset + size + ((512 - (size % 512)) % 512);
  }
  return entries;
};

const service = (
  artifact: ServicePlan["artifact"],
  caFiles: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ServicePlan => ({
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {
    "@lando/core/service-features": {
      buildSteps: [{ id: "lando.security:trust-store", phase: "build", command: trustStoreCommand, caFiles }],
    },
  },
});

const plan = (servicePlan: ServicePlan): AppPlan => ({
  id: appId,
  name: "CA Build App",
  slug: "ca-build-app",
  root: AbsolutePath.make("/tmp/ca-build-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const descriptor = (path: string, content: Uint8Array) => {
  const digest = createHash("sha256").update(content).digest("hex");
  return { path, digest, archiveName: `lando-${digest}.crt` };
};

test("packs verified CAs and renders COPY before the owning trust-store RUN", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-image-ca-ref-"));
  try {
    // Given
    const pem = new TextEncoder().encode("-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n");
    const caPath = join(root, "corp.pem");
    await writeFile(caPath, pem);
    const ca = descriptor(caPath, pem);
    const postBodies: Uint8Array[] = [];
    const api = {
      request: (request: ContainerBuildHttpRequest) =>
        Effect.promise(async () => {
          if (request.method === "POST") postBodies.push(await collect(request.stdin));
          return { status: 200, body: request.method === "GET" ? "{}" : "" };
        }),
    };

    // When
    await Effect.runPromise(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(service({ kind: "ref", ref: "debian:12" }, [ca])),
          buildKey: "ca-ref",
        },
        { providerId, api },
      ),
    );

    // Then
    expect(postBodies).toHaveLength(1);
    const entries = tarEntries(postBodies[0] ?? new Uint8Array());
    const caEntry = entries.find((entry) => entry.name === `.lando-ca/${ca.archiveName}`);
    expect(caEntry?.mode).toBe(0o644);
    expect(caEntry?.content).toEqual(pem);
    const dockerfile = new TextDecoder().decode(
      entries.find((entry) => entry.name === "Dockerfile")?.content,
    );
    expect(dockerfile).toContain(
      `COPY .lando-ca/${ca.archiveName} /usr/local/share/ca-certificates/${ca.archiveName}`,
    );
    expect(dockerfile.indexOf("COPY ")).toBeLessThan(dockerfile.indexOf(`RUN ${trustStoreCommand}`));
    expect(dockerfile).toContain("mkdir -p /etc/lando/certs");
    expect(dockerfile).toContain("update-ca-certificates");
    expect(dockerfile).toContain("update-ca-trust extract");
    expect(dockerfile).toContain("> /etc/lando/certs/ca-bundle.pem");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adds CA files only to the derived request for authored build plus steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-image-ca-build-"));
  try {
    // Given
    const pem = new TextEncoder().encode("corp-ca");
    const caPath = join(root, "corp.pem");
    await writeFile(join(root, "Containerfile"), "FROM alpine\n");
    await writeFile(caPath, pem);
    const ca = descriptor(caPath, pem);
    const postBodies: Uint8Array[] = [];
    const api = {
      request: (request: ContainerBuildHttpRequest) =>
        Effect.promise(async () => {
          if (request.method === "POST") postBodies.push(await collect(request.stdin));
          return { status: 200, body: request.method === "GET" ? "{}" : "" };
        }),
    };

    // When
    await Effect.runPromise(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(
            service(
              { kind: "build", context: AbsolutePath.make(root), spec: PortablePath.make("Containerfile") },
              [ca],
            ),
          ),
          buildKey: "ca-build",
        },
        { providerId, api },
      ),
    );

    // Then
    expect(postBodies).toHaveLength(2);
    expect(tarEntries(postBodies[0] ?? new Uint8Array()).map((entry) => entry.name)).not.toContain(
      `.lando-ca/${ca.archiveName}`,
    );
    expect(tarEntries(postBodies[1] ?? new Uint8Array()).map((entry) => entry.name)).toContain(
      `.lando-ca/${ca.archiveName}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["missing file", { path: "/missing/corp.pem", digest: "a".repeat(64), archiveName: "corp.crt" }],
  ["digest mismatch", { path: "FILE", digest: "b".repeat(64), archiveName: "corp.crt" }],
  ["uppercase digest", { path: "FILE", digest: "A".repeat(64), archiveName: "corp.crt" }],
  ["unsafe archive name", { path: "FILE", digest: "a".repeat(64), archiveName: "../corp.crt" }],
])("rejects %s before the first API request", async (_case, input) => {
  const root = await mkdtemp(join(tmpdir(), "lando-image-ca-failure-"));
  try {
    // Given
    const caPath = join(root, "corp.pem");
    await writeFile(caPath, "corp-ca");
    const ca = { ...input, path: input.path === "FILE" ? caPath : input.path };
    let requests = 0;
    const api = {
      request: () => {
        requests += 1;
        return Effect.succeed({ status: 200, body: "" });
      },
    };

    // When
    const failure = await Effect.runPromise(
      Effect.flip(
        buildContainerArtifact(
          {
            app: appId,
            service: serviceName,
            plan: plan(service({ kind: "ref", ref: "debian:12" }, [ca])),
            buildKey: "ca-failure",
          },
          { providerId, api },
        ),
      ),
    );

    // Then
    expect(failure._tag).toBe("ProviderInternalError");
    expect(failure.operation).toBe("buildArtifact");
    expect(requests).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
