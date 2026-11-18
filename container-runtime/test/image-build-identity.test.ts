import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerBuildHttpRequest } from "@lando/container-runtime/image-build";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect, Stream } from "effect";
import { requestContainerBuild } from "../src/image-build-http.ts";
import { dockerfileFrom, runBuild } from "./image-build-user-fixture.ts";

test.each([false, true])("classic build uses the last stage aux.ID with streamed=%s", async (streamed) => {
  const frames = '{"aux":{"ID":"sha256:first","Digest":"sha256:digest"}}\n{"aux":{"ID":"sha256:last"}}\n';
  const inspected: string[] = [];
  const request = (input: ContainerBuildHttpRequest) => {
    if (input.method === "GET") inspected.push(input.path);
    return Effect.succeed({ status: 200, body: input.method === "POST" ? frames : "{}" });
  };
  const result = await Effect.runPromise(
    requestContainerBuild({
      request,
      ...(streamed ? { stream: () => Stream.make(new TextEncoder().encode(frames)) } : {}),
      options: { providerId: "docker", api: { request }, sourceEnv: {} },
      path: "/build",
      stdin: (async function* () {})(),
      secretValues: [],
    }),
  );
  expect(result).toEqual({ id: "sha256:last", digest: "sha256:digest" });
  expect(inspected).toEqual(["/images/last/json"]);
});

test("a multistage target builds an untagged labeled base and derives from its final ID without pulling", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-build-identity-"));
  try {
    const requests: ContainerBuildHttpRequest[] = [];
    await Effect.runPromise(
      runBuild({
        artifact: {
          kind: "build",
          context: AbsolutePath.make(root),
          specInline: "FROM scratch AS first\nFROM first AS selected\n",
          target: "selected",
        },
        steps: [{ phase: "build", command: "echo derived" }],
        request: (input) => {
          requests.push(input);
          return Effect.succeed({
            status: 200,
            body:
              input.method === "POST"
                ? '{"aux":{"ID":"sha256:first"}}\n{"aux":{"ID":"sha256:selected"}}\n'
                : "{}",
          });
        },
      }),
    );
    const posts = requests.filter((request) => request.method === "POST");
    const params = posts.map((request) => new URL(request.path, "http://engine").searchParams);
    expect(params.map((query) => query.get("t"))).toEqual([null, "lando-build-docker-web-user-key"]);
    expect(params.map((query) => query.get("labels"))).toEqual([
      '{"dev.lando.test":"user-fixture"}',
      '{"dev.lando.test":"user-fixture"}',
    ]);
    expect(params.map((query) => query.get("target"))).toEqual(["selected", null]);
    expect(params.map((query) => query.has("pull"))).toEqual([false, false]);
    const derived = posts[1];
    expect(derived).toBeDefined();
    if (derived === undefined) throw new TypeError("Missing derived build");
    expect(await dockerfileFrom(derived)).toBe("FROM sha256:selected\nRUN echo derived\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an untagged build without aux.ID fails before inspection or a derived build", async () => {
  const requests: ContainerBuildHttpRequest[] = [];
  const failure = await Effect.runPromise(
    Effect.flip(
      runBuild({
        artifact: { kind: "ref", ref: "alpine:3.20" },
        user: "root",
        steps: [{ phase: "build", command: "true" }],
        request: (request) => {
          requests.push(request);
          return Effect.succeed({ status: 200, body: "" });
        },
      }),
    ),
  );
  expect(failure._tag).toBe("ProviderInternalError");
  expect(failure.message).toContain("aux.ID");
  expect(failure.remediation).toContain("provider logs");
  expect(requests.map((request) => request.method)).toEqual(["POST"]);
});
