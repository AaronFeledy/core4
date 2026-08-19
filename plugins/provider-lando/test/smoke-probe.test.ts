import { describe, expect, test } from "bun:test";
import { Deferred, Duration, Effect, Fiber, TestClock, TestContext } from "effect";

import type { ProviderUnavailableError } from "@lando/sdk/errors";
import type { RetryPolicy } from "@lando/sdk/probe";

import type { PodmanApiClient, PodmanHttpRequest } from "../src/capabilities.ts";
import { ProviderLandoSmokeError, type SmokeOperation, runSmokeReadinessProbe } from "../src/smoke-probe.ts";

const retryPolicy: RetryPolicy = {
  maxAttempts: 3,
  delay: Duration.millis(10),
  timeout: Duration.seconds(1),
};

interface FakeOptions {
  readonly runExitCode?: number;
  readonly health?: ReadonlyArray<"healthy" | "starting" | "unhealthy">;
  readonly failBuild?: ProviderUnavailableError;
  readonly failBaseImage?: boolean;
  readonly blockHealthInspect?: Deferred.Deferred<void>;
}

const fakeApi = (requests: PodmanHttpRequest[], options: FakeOptions = {}): PodmanApiClient => {
  let healthInspect = 0;
  let imageExists = options.failBaseImage !== true;
  return {
    info: Effect.succeed({}),
    ping: Effect.void,
    request: (request) =>
      Effect.gen(function* () {
        requests.push(request);
        const path = request.path;
        if (path.startsWith("/images/") && path.endsWith("/json")) {
          return { status: imageExists ? 204 : 404, body: "" };
        }
        if (path.startsWith("/libpod/images/pull")) {
          if (options.failBaseImage === true) return { status: 500, body: "registry token=s3cr3t" };
          imageExists = true;
          return { status: 200, body: "{}" };
        }
        if (path.startsWith("/build?")) {
          if (options.failBuild !== undefined) return yield* Effect.fail(options.failBuild);
          return { status: 200, body: "{}" };
        }
        if (path.includes("/wait")) {
          return { status: 200, body: JSON.stringify({ StatusCode: options.runExitCode ?? 0 }) };
        }
        if (path.endsWith("/json")) {
          if (options.blockHealthInspect !== undefined) yield* Deferred.await(options.blockHealthInspect);
          const states = options.health ?? ["healthy"];
          const health = states[Math.min(healthInspect, states.length - 1)] ?? "healthy";
          healthInspect += 1;
          return { status: 200, body: JSON.stringify({ State: { Health: { Status: health } } }) };
        }
        return { status: request.method === "POST" ? 201 : 204, body: JSON.stringify({ Id: "created" }) };
      }),
  };
};

const run = (requests: PodmanHttpRequest[], options: FakeOptions = {}) =>
  Effect.scoped(
    runSmokeReadinessProbe({
      podmanApi: fakeApi(requests, options),
      retryPolicy,
    }),
  );

const deletionPaths = (requests: ReadonlyArray<PodmanHttpRequest>): ReadonlyArray<string> =>
  requests.filter((request) => request.method === "DELETE").map((request) => request.path);

describe("runSmokeReadinessProbe", () => {
  test("completes run, build-and-resolve, and healthy-container outcomes", async () => {
    const requests: PodmanHttpRequest[] = [];

    await Effect.runPromise(run(requests));

    expect(requests.some((request) => request.path.includes("/wait"))).toBe(true);
    expect(requests.some((request) => request.path.startsWith("/build?"))).toBe(true);
    expect(
      requests.some((request) => request.path.startsWith("/images/") && request.path.endsWith("/json")),
    ).toBe(true);
    expect(requests.some((request) => request.path.endsWith("/json"))).toBe(true);
    expect(deletionPaths(requests)).toHaveLength(3);
  });

  test("uses Docker-compatible lifecycle endpoints with matching create bodies", async () => {
    const requests: PodmanHttpRequest[] = [];

    await Effect.runPromise(run(requests));

    const creates = requests.filter(
      (request) => request.method === "POST" && request.path.startsWith("/containers/create?name="),
    );
    expect(creates).toHaveLength(2);
    expect(creates[0]?.body).toEqual({
      Image: "docker.io/library/alpine:3.20.3",
      Cmd: ["sh", "-c", "exit 0"],
    });
    expect(creates[1]?.body).toEqual({
      Image: "docker.io/library/alpine:3.20.3",
      Cmd: ["sh", "-c", "sleep 60"],
      Healthcheck: {
        Test: ["CMD-SHELL", "exit 0"],
        Interval: 100_000_000,
        Timeout: 1_000_000_000,
        Retries: 1,
      },
    });
    expect(
      requests.some(
        (request) =>
          request.method === "GET" && /^\/libpod\/containers\/[^/]+\/healthcheck$/u.test(request.path),
      ),
    ).toBe(true);
    expect(requests.some((request) => /^\/containers\/[^/]+\/start$/u.test(request.path))).toBe(true);
    expect(requests.some((request) => /^\/containers\/[^/]+\/wait$/u.test(request.path))).toBe(true);
    expect(requests.some((request) => /^\/containers\/[^/]+\/json$/u.test(request.path))).toBe(true);
    expect(requests.some((request) => /^\/containers\/[^/?]+\?force=true$/u.test(request.path))).toBe(true);
  });

  test("reports a non-zero run exit with a redacted operation discriminator", async () => {
    const requests: PodmanHttpRequest[] = [];

    const failure = await Effect.runPromise(run(requests, { runExitCode: 17 }).pipe(Effect.flip));

    expect(failure).toBeInstanceOf(ProviderLandoSmokeError);
    expect(failure.smokeOperation).toBe("run");
    expect(failure.details).toMatchObject({ exitCode: 17 });
    expect(deletionPaths(requests).some((path) => path.includes("containers"))).toBe(true);
  });

  test("confirms the built image resolves after submitting a tar build context", async () => {
    const requests: PodmanHttpRequest[] = [];

    await Effect.runPromise(run(requests));

    const build = requests.find((request) => request.path.startsWith("/build?"));
    expect(build?.headers?.["Content-Type"]).toBe("application/x-tar");
    expect(build?.stdin).toBeDefined();
    expect(build?.path).toContain("dockerfile=Dockerfile");
    if (build?.stdin === undefined) throw new Error("expected smoke build context");
    const chunks: Uint8Array[] = [];
    for await (const chunk of build.stdin) chunks.push(chunk);
    const tar = new Uint8Array(Bun.concatArrayBuffers(chunks));
    const dockerfile = "FROM docker.io/library/alpine:3.20.3\n";
    expect(new TextDecoder().decode(tar.slice(512, 512 + dockerfile.length))).toBe(dockerfile);
    expect(Array.from(tar.slice(-1024)).every((byte) => byte === 0)).toBe(true);
    expect(
      requests.some(
        (request) => request.path.includes("provider-lando-smoke-build") && request.path.endsWith("/json"),
      ),
    ).toBe(true);
  });

  test("retries a starting healthcheck deterministically before healthy", async () => {
    const requests: PodmanHttpRequest[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(run(requests, { health: ["starting", "healthy"] }));
        yield* TestClock.adjust(Duration.millis(10));
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(
      requests.filter((request) => request.path.startsWith("/containers/") && request.path.endsWith("/json")),
    ).toHaveLength(2);
  });

  test("reports unhealthy as a health operation failure", async () => {
    const requests: PodmanHttpRequest[] = [];

    const failure = await Effect.runPromise(run(requests, { health: ["unhealthy"] }).pipe(Effect.flip));

    expect(failure).toBeInstanceOf(ProviderLandoSmokeError);
    expect(failure.smokeOperation).toBe("health");
    expect(deletionPaths(requests).some((path) => path.includes("containers"))).toBe(true);
  });

  test("distinguishes base-image acquisition from host operation incapability and redacts lastError", async () => {
    const requests: PodmanHttpRequest[] = [];

    const failure = await Effect.runPromise(run(requests, { failBaseImage: true }).pipe(Effect.flip));

    expect(failure.smokeOperation).toBe("base-image" satisfies SmokeOperation);
    expect(requests.some((request) => request.path.startsWith("/libpod/images/pull?reference="))).toBe(true);
    expect(JSON.stringify(failure.details)).not.toContain("s3cr3t");
    expect(failure.remediation).toContain("registry");
  });

  test("cleans acquired resources when interrupted", async () => {
    const requests: PodmanHttpRequest[] = [];
    const blocker = await Effect.runPromise(Deferred.make<void>());
    const api = fakeApi(requests, { blockHealthInspect: blocker });
    const program = Effect.scoped(runSmokeReadinessProbe({ podmanApi: api, retryPolicy }));
    const fiber = Effect.runFork(program);
    while (
      !requests.some((request) => request.path.startsWith("/containers/") && request.path.endsWith("/json"))
    )
      await Bun.sleep(1);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(deletionPaths(requests).some((path) => path.includes("containers"))).toBe(true);
    expect(deletionPaths(requests).some((path) => path.includes("images"))).toBe(true);
  });
});
