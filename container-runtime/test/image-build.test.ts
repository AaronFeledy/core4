import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import {
  type ContainerBuildHttpRequest,
  buildContainerArtifact,
  buildContextContentDigest,
  packBuildContext,
} from "@lando/container-runtime/image-build";
import { ProviderUnavailableError } from "@lando/sdk/errors";
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
const appId = AppId.make("build-app");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-12T00:00:00Z"),
  source: "container-runtime/image-build.test.ts",
  runtime: 4 as const,
};

const service = (input: Partial<ServicePlan> = {}): ServicePlan => ({
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
  ...input,
});

const plan = (servicePlan: ServicePlan): AppPlan => ({
  id: appId,
  name: "Build App",
  slug: "build-app",
  root: AbsolutePath.make("/tmp/build-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

type TarEntry = {
  readonly name: string;
  readonly mode: number;
  readonly type: string;
  readonly linkName: string;
  readonly content: string;
};

const collect = async (input: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
  if (input === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const octal = (bytes: Uint8Array): number =>
  Number.parseInt(new TextDecoder().decode(bytes).replace(/\0.*$/u, "").trim() || "0", 8);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).replace(/\0.*$/u, "");

const tarEntries = (archive: Uint8Array): readonly TarEntry[] => {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header.subarray(0, 100));
    const mode = octal(header.subarray(100, 108));
    const size = octal(header.subarray(124, 136));
    const type = text(header.subarray(156, 157)) || "0";
    const linkName = text(header.subarray(157, 257));
    const contentOffset = offset + 512;
    entries.push({
      name,
      mode,
      type,
      linkName,
      content: new TextDecoder().decode(archive.subarray(contentOffset, contentOffset + size)),
    });
    offset = contentOffset + size + ((512 - (size % 512)) % 512);
  }
  return entries;
};

test("packBuildContext applies ordered dockerignore patterns and preserves tar metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-context-pack-"));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, ".dockerignore"), "# comment\ndist/\n!dist/keep.txt\n*.log\n");
  await writeFile(join(root, "src", "app.ts"), "console.log('ok')\n");
  await writeFile(join(root, "dist", "drop.txt"), "drop\n");
  await writeFile(join(root, "dist", "keep.txt"), "keep\n");
  await writeFile(join(root, "debug.log"), "secret\n");
  await writeFile(join(root, "run.sh"), "#!/bin/sh\n");
  await chmod(join(root, "run.sh"), 0o755);
  await symlink("src/app.ts", join(root, "app-link"));

  const packed = await packBuildContext(AbsolutePath.make(root));
  const entries = tarEntries(await collect(packed.tar));

  expect(entries.map((entry) => entry.name)).toEqual([
    ".dockerignore",
    "app-link",
    "dist/keep.txt",
    "run.sh",
    "src/app.ts",
  ]);
  expect(entries.find((entry) => entry.name === "run.sh")?.mode).toBe(0o755);
  expect(entries.find((entry) => entry.name === "app-link")).toEqual(
    expect.objectContaining({ type: "2", linkName: "src/app.ts", content: "" }),
  );
});

test("buildContextContentDigest changes for same-path content edits and matches across roots", async () => {
  const first = await mkdtemp(join(tmpdir(), "lando-context-digest-a-"));
  const second = await mkdtemp(join(tmpdir(), "lando-context-digest-b-"));
  await writeFile(join(first, "Dockerfile"), "FROM alpine\n");
  await writeFile(join(second, "Dockerfile"), "FROM alpine\n");

  const firstDigest = await buildContextContentDigest(AbsolutePath.make(first));
  const secondDigest = await buildContextContentDigest(AbsolutePath.make(second));
  await writeFile(join(first, "Dockerfile"), "FROM busybox\n");
  const changedDigest = await buildContextContentDigest(AbsolutePath.make(first));

  expect(secondDigest).toBe(firstDigest);
  expect(changedDigest).not.toBe(firstDigest);
});

test("buildContainerArtifact preserves shell and exec RUN forms and rejects control injection", async () => {
  const requests: ContainerBuildHttpRequest[] = [];
  const bodies: string[] = [];
  const api = {
    request: (request: ContainerBuildHttpRequest) =>
      Effect.promise(async () => {
        requests.push(request);
        bodies.push(new TextDecoder().decode(await collect(request.stdin)));
        return { status: 200, body: "" };
      }),
  };
  const providerOptions = { providerId, api };

  await Effect.runPromise(
    buildContainerArtifact(
      {
        app: appId,
        service: serviceName,
        plan: plan(
          service({
            artifact: { kind: "ref", ref: "debian:12" },
            extensions: {
              "@lando/core/service-features": {
                buildSteps: [
                  { id: "shell", phase: "build", command: "echo $HOME && printf '%s' ok" },
                  { id: "exec", phase: "build", command: ["printf", "hello world"] },
                ],
              },
            },
          }),
        ),
        buildKey: "run-forms",
      },
      providerOptions,
    ),
  );

  expect(requests).toHaveLength(2);
  expect(bodies[0]).toContain("FROM debian:12\n");
  expect(bodies[0]).toContain("RUN echo $HOME && printf '%s' ok\n");
  expect(bodies[0]).toContain('RUN ["printf","hello world"]\n');

  const failure = await Effect.runPromise(
    Effect.flip(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(
            service({
              artifact: { kind: "ref", ref: "debian:12\nFROM evil" },
              extensions: {
                "@lando/core/service-features": {
                  buildSteps: [{ id: "exec", phase: "build", command: ["echo", "ok"] }],
                },
              },
            }),
          ),
          buildKey: "bad-base",
        },
        providerOptions,
      ),
    ),
  );

  expect(failure._tag).toBe("ProviderInternalError");
  expect(failure.message).toContain("control characters");
});

test("buildContainerArtifact pins a resolved base digest in derived Dockerfiles", async () => {
  // Given
  const bodies: string[] = [];
  const api = {
    request: (request: ContainerBuildHttpRequest) =>
      Effect.promise(async () => {
        if (request.method === "POST") bodies.push(new TextDecoder().decode(await collect(request.stdin)));
        return { status: 200, body: request.method === "GET" ? "{}" : "" };
      }),
  };
  const derived = service({
    artifact: { kind: "ref", ref: "php:8.4-apache-bookworm", digest: "sha256:resolved-base" },
    extensions: {
      "@lando/core/service-features": {
        buildSteps: [{ id: "extension", phase: "build", command: ["echo", "build"] }],
      },
    },
  });

  // When
  await Effect.runPromise(
    buildContainerArtifact(
      { app: appId, service: serviceName, plan: plan(derived), buildKey: "resolved-base" },
      { providerId, api },
    ),
  );

  // Then
  expect(bodies[0]).toContain("FROM php:8.4-apache-bookworm@sha256:resolved-base");
});

test("buildContainerArtifact redacts raw and encoded build args from provider errors", async () => {
  const rawSecret = "topsecret";
  const encodedSecret = encodeURIComponent(rawSecret);
  const context = await mkdtemp(join(tmpdir(), "lando-context-error-"));
  await writeFile(join(context, "Dockerfile"), "FROM alpine\n");
  const error = new ProviderUnavailableError({
    providerId,
    operation: "buildArtifact",
    message: `/build?t=x&buildargs={\"TOKEN\":\"${rawSecret}\"}`,
    details: { path: `/build?t=x&buildargs=%7B%22TOKEN%22%3A%22${encodedSecret}%22%7D` },
  });
  const api = { request: () => Effect.fail(error) };

  const failure = await Effect.runPromise(
    Effect.flip(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(
            service({
              artifact: {
                kind: "build",
                context: AbsolutePath.make(context),
                spec: PortablePath.make("Dockerfile"),
                args: { TOKEN: rawSecret },
              },
            }),
          ),
          buildKey: "secret-error",
        },
        { providerId, api },
      ),
    ),
  );

  expect(JSON.stringify(failure)).not.toContain(rawSecret);
  expect(JSON.stringify(failure)).not.toContain(encodedSecret);
  expect(failure.message).toContain("buildargs=[redacted]");
});

test("injects the inline Dockerfile into the packed context and preserves real context entries", async () => {
  // Given
  const context = await mkdtemp(join(tmpdir(), "lando-context-inline-"));
  await writeFile(join(context, "context-marker.txt"), "preserved\n");
  let requestBody: Uint8Array = new Uint8Array();
  const api = {
    request: (request: ContainerBuildHttpRequest) =>
      Effect.promise(async () => {
        if (request.method === "POST") requestBody = await collect(request.stdin);
        return { status: 200, body: "" };
      }),
  };

  // When
  await Effect.runPromise(
    buildContainerArtifact(
      {
        app: appId,
        service: serviceName,
        plan: plan(
          service({
            artifact: {
              kind: "build",
              context: AbsolutePath.make(context),
              specInline: "FROM alpine:3.20",
            },
          }),
        ),
        buildKey: "inline-preserves-context",
      },
      { providerId, api },
    ),
  );

  // Then
  const entries = tarEntries(requestBody);
  expect(entries.map((entry) => entry.name)).toContain("context-marker.txt");
  expect(entries.map((entry) => entry.name)).toContain(".lando/Dockerfile.inline");
  expect(entries.find((entry) => entry.name === ".lando/Dockerfile.inline")?.content).toBe(
    "FROM alpine:3.20",
  );
});

test("points the daemon dockerfile param at the Lando owned path", async () => {
  // Given
  const context = await mkdtemp(join(tmpdir(), "lando-context-inline-path-"));
  let requestPath = "";
  const api = {
    request: (request: ContainerBuildHttpRequest) => {
      if (request.method === "POST") requestPath = request.path;
      return Effect.succeed({ status: 200, body: "" });
    },
  };

  // When
  await Effect.runPromise(
    buildContainerArtifact(
      {
        app: appId,
        service: serviceName,
        plan: plan(
          service({
            artifact: {
              kind: "build",
              context: AbsolutePath.make(context),
              specInline: "FROM alpine:3.20",
            },
          }),
        ),
        buildKey: "inline-daemon-path",
      },
      { providerId, api },
    ),
  );

  // Then
  expect(requestPath).toContain("dockerfile=.lando%2FDockerfile.inline");
});

test("drops a colliding user entry at the Lando owned path", async () => {
  // Given
  const context = await mkdtemp(join(tmpdir(), "lando-context-inline-collision-"));
  await mkdir(join(context, ".lando"));
  await writeFile(join(context, ".lando", "Dockerfile.inline"), "FROM user-content");
  let requestBody: Uint8Array = new Uint8Array();
  const api = {
    request: (request: ContainerBuildHttpRequest) =>
      Effect.promise(async () => {
        if (request.method === "POST") requestBody = await collect(request.stdin);
        return { status: 200, body: "" };
      }),
  };

  // When
  await Effect.runPromise(
    buildContainerArtifact(
      {
        app: appId,
        service: serviceName,
        plan: plan(
          service({
            artifact: {
              kind: "build",
              context: AbsolutePath.make(context),
              specInline: "FROM inline-content",
            },
          }),
        ),
        buildKey: "inline-collision",
      },
      { providerId, api },
    ),
  );

  // Then
  const inlineEntries = tarEntries(requestBody).filter((entry) => entry.name === ".lando/Dockerfile.inline");
  expect(inlineEntries).toHaveLength(1);
  expect(inlineEntries[0]?.content).toBe("FROM inline-content");
});

test("fails when spec and specInline are both set", async () => {
  // Given
  const context = await mkdtemp(join(tmpdir(), "lando-context-inline-conflict-"));
  await writeFile(join(context, "Dockerfile"), "FROM context-spec");
  const api = {
    request: () => Effect.succeed({ status: 200, body: "" }),
  };

  // When
  const failure = await Effect.runPromise(
    Effect.flip(
      buildContainerArtifact(
        {
          app: appId,
          service: serviceName,
          plan: plan(
            service({
              artifact: {
                kind: "build",
                context: AbsolutePath.make(context),
                spec: PortablePath.make("Dockerfile"),
                specInline: "FROM inline-spec",
              },
            }),
          ),
          buildKey: "inline-conflict",
        },
        { providerId, api },
      ),
    ),
  );

  // Then
  expect(failure._tag).toBe("ProviderInternalError");
  expect(failure.message).toContain("spec");
  expect(failure.message).toContain("specInline");
});

test("builds from the packed context unchanged when specInline is absent", async () => {
  // Given
  const context = await mkdtemp(join(tmpdir(), "lando-context-file-spec-"));
  await writeFile(join(context, "Containerfile"), "FROM alpine:3.20");
  await writeFile(join(context, "context-marker.txt"), "preserved\n");
  let capturedRequest: ContainerBuildHttpRequest | undefined;
  const api = {
    request: (request: ContainerBuildHttpRequest) =>
      Effect.promise(async () => {
        if (request.method === "POST") capturedRequest = request;
        return { status: 200, body: "" };
      }),
  };

  // When
  await Effect.runPromise(
    buildContainerArtifact(
      {
        app: appId,
        service: serviceName,
        plan: plan(
          service({
            artifact: {
              kind: "build",
              context: AbsolutePath.make(context),
              spec: PortablePath.make("Containerfile"),
            },
          }),
        ),
        buildKey: "file-spec-regression",
      },
      { providerId, api },
    ),
  );

  // Then
  expect(capturedRequest?.path).toContain("dockerfile=Containerfile");
  const entries = tarEntries(await collect(capturedRequest?.stdin));
  expect(entries.map((entry) => entry.name)).toEqual(["Containerfile", "context-marker.txt"]);
  expect(entries.map((entry) => entry.name)).not.toContain(".lando/Dockerfile.inline");
});
