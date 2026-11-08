import { expect, test } from "bun:test";
import {
  HealthcheckTargetUnsupportedError,
  ServiceNotFoundError,
  ServiceStartError,
} from "@lando/sdk/errors";
import { AbsolutePath, AppId, HealthcheckPlan, ServiceName } from "@lando/sdk/schema";
import { makeTestRuntimeProvider, runProviderContract, runProviderDataPlaneContract } from "@lando/sdk/test";
import { Effect, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { testProviderPlan as plan } from "./test-provider-plan.ts";

const target = { app: plan.id, service: ServiceName.make("web") };
const apply = (provider: ReturnType<typeof makeTestRuntimeProvider>) =>
  provider.apply(plan, { reconcile: true });

test("the in-memory provider conforms to lifecycle and data-plane contracts", async () => {
  await Effect.runPromise(runProviderContract(makeTestRuntimeProvider()));
  await Effect.runPromise(
    runProviderDataPlaneContract({ factory: () => Effect.succeed(makeTestRuntimeProvider()) }),
  );
});

test("exec collects the exact stream bytes, including its trailing newline", async () => {
  const provider = makeTestRuntimeProvider();
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* apply(provider);
        const command = { command: ["echo", "hello"] };
        const chunks = yield* Stream.runCollect(provider.execStream(target, command));
        const collected = yield* provider.exec(target, command);
        return { chunks: [...chunks], collected };
      }),
    ),
  );
  expect(result.collected).toEqual({ exitCode: 0, stdout: "echo hello\n", stderr: "" });
  expect(result.chunks).toEqual([
    { kind: "stdout", chunk: new TextEncoder().encode("echo hello\n") },
    { exitCode: 0 },
  ]);
});

test.each(["app", "service"] as const)(
  "missing %s fails service operations with ServiceNotFoundError",
  async (missing) => {
    const provider = makeTestRuntimeProvider();
    await Effect.runPromise(Effect.scoped(apply(provider)));
    const absent =
      missing === "app"
        ? { ...target, app: AppId.make("absent") }
        : { ...target, service: ServiceName.make("absent") };
    const operations = [
      provider.exec(absent, { command: ["echo"] }),
      Effect.scoped(Stream.runDrain(provider.execStream(absent, { command: ["echo"] }))),
      provider.inspect(absent),
      Stream.runDrain(provider.logs(absent, { follow: false })),
    ];
    for (const operation of operations) {
      const result = await Effect.runPromise(Effect.result(operation));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ServiceNotFoundError);
    }
  },
);

test("apply observes only its services, preserves a running start time and isolates instances", async () => {
  const provider = makeTestRuntimeProvider();
  const web = plan.services[target.service];
  if (web === undefined) throw new Error("fixture requires web");
  const worker = ServiceName.make("worker");
  const canonicalRoot = AbsolutePath.make("/tmp/canonical-provider-app");
  const twoServices = {
    ...plan,
    identity: { appRoot: canonicalRoot, ownerKey: "test-owner" },
    services: { ...plan.services, [worker]: { ...web, name: worker } },
  };
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* provider.apply(twoServices, { reconcile: true });
        const first = yield* provider.inspect(target);
        yield* TestClock.adjust("1 second");
        yield* provider.apply(twoServices, { reconcile: true });
        return {
          first,
          again: yield* provider.inspect(target),
          listed: yield* provider.list({}),
          empty: yield* makeTestRuntimeProvider().list({}),
        };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result.listed.map(({ service, status, appRoot }) => ({ service, status, appRoot }))).toEqual([
    { service: target.service, status: "running", appRoot: canonicalRoot },
    { service: worker, status: "running", appRoot: canonicalRoot },
  ]);
  expect(result.empty).toEqual([]);
  expect(result.again).toMatchObject({
    app: plan.id,
    appRoot: canonicalRoot,
    status: "running",
    service: target.service,
  });
  expect(result.again.containerId).toBe(result.first.containerId);
  expect(result.again.lastStartedAt).toEqual(result.first.lastStartedAt);
});

test.each(["start", "restart"] as const)("%s resumes a stopped container", async (operation) => {
  const provider = makeTestRuntimeProvider();
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* apply(provider);
        const first = yield* provider.inspect(target);
        yield* TestClock.adjust("1 second");
        yield* provider.stop(target);
        const stopped = yield* provider.inspect(target);
        yield* provider[operation](target);
        return { first, stopped, resumed: yield* provider.inspect(target) };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result.stopped.status).toBe("exited");
  expect(result.stopped.lastStartedAt).toEqual(result.first.lastStartedAt);
  expect(result.resumed.status).toBe("running");
  expect(result.resumed.lastStartedAt?.getTime()).toBe((result.first.lastStartedAt?.getTime() ?? 0) + 1000);
});

test("host readiness without a delegate fails before creating containers", async () => {
  const provider = makeTestRuntimeProvider();
  const web = plan.services[target.service];
  if (web === undefined) throw new Error("fixture requires web");
  const readiness = Schema.decodeUnknownSync(HealthcheckPlan)({
    kind: "command",
    executionTarget: "host",
    command: ["true"],
    intervalSeconds: 0,
    timeoutSeconds: 1,
    retries: 1,
  });
  const result = await Effect.runPromise(
    Effect.result(
      Effect.scoped(
        provider.apply(
          { ...plan, services: { [target.service]: { ...web, readiness } } },
          { reconcile: true },
        ),
      ),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(HealthcheckTargetUnsupportedError);
  expect(await Effect.runPromise(provider.list({}))).toEqual([]);
});

test("removal requires the observed generation and destroy affects only its app", async () => {
  const provider = makeTestRuntimeProvider();
  await Effect.runPromise(Effect.scoped(apply(provider)));
  const observed = await Effect.runPromise(provider.inspect(target));
  expect(
    await Effect.runPromise(provider.removeObservedService({ ...observed, containerId: "other" })),
  ).toEqual({ kind: "absent" });
  expect(await Effect.runPromise(provider.removeObservedService(observed))).toEqual({ kind: "removed" });
  expect(await Effect.runPromise(provider.removeObservedService(observed))).toEqual({ kind: "absent" });
  await Effect.runPromise(Effect.scoped(apply(provider)));
  expect(await Effect.runPromise(provider.removeObservedService(observed))).toEqual({ kind: "absent" });
  const other = { ...plan, id: AppId.make("other") };
  await Effect.runPromise(Effect.scoped(provider.apply(other, { reconcile: true })));
  await Effect.runPromise(provider.destroy(target, { volumes: false }));
  expect((await Effect.runPromise(provider.list({}))).map((info) => info.app)).toEqual([other.id]);
});

test.each(["exit", "error"] as const)("apply fails on delegated readiness %s", async (failure) => {
  const provider = makeTestRuntimeProvider();
  const web = plan.services[target.service];
  if (web === undefined) throw new Error("fixture requires web");
  const readiness = Schema.decodeUnknownSync(HealthcheckPlan)({
    kind: "command",
    command: ["false"],
    intervalSeconds: 0,
    timeoutSeconds: 1,
    retries: 1,
  });
  const error = new ServiceStartError({
    providerId: "test",
    service: "web",
    operation: "readiness",
    message: "failed",
    remediation: "fix probe",
  });
  const result = await Effect.runPromise(
    Effect.result(
      Effect.scoped(
        provider.apply(
          { ...plan, services: { [target.service]: { ...web, readiness } } },
          {
            reconcile: true,
            executeReadinessAttempt: (service, probe) => {
              expect(service).toBe(target.service);
              expect(probe).toEqual(readiness);
              return failure === "error"
                ? Effect.fail(error)
                : Effect.succeed({ exitCode: 1, stdout: "", stderr: "" });
            },
          },
        ),
      ),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ServiceStartError);
});
