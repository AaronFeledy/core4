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

  expect(requests).toHaveLength(1);
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
