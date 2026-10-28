import { expect, test } from "bun:test";
import { type DataPlaneApiClient, makeProviderDataPlane } from "@lando/container-runtime/data-plane";
import { makeRedactionService } from "@lando/redaction/service";
import {
  FailureRoleAnnotation,
  annotateFailureRole,
  encodeCommandResult,
  failureOutcomeFromCause,
  identityRedactor,
  taggedErrorJson,
} from "@lando/sdk/command-result";
import {
  ProviderCapabilityError,
  ProviderInternalError,
  ProviderUnavailableError,
  ServiceExecError,
  VolumeOperationError,
} from "@lando/sdk/errors";
import { AppId, PortablePath } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { Cause, Context, Effect, Exit, Result, Schema, Stream } from "effect";

const secret = "ephemeral-registered-secret-identity-canary";
const debugCause = { private: secret };
const fields = {
  providerId: "test",
  operation: "fixture.original",
  message: `Failed ${secret}`,
  remediation: `Retry safely ${secret}`,
  details: { nested: [secret, { value: secret }] },
  cause: debugCause,
};
const spec = {
  image: "fixture",
  command: ["true", "unregistered-private-argv"],
  env: { PRIVATE: "unregistered-private-env" },
  remove: true,
};
const modes = ["run", "runStream"] as const;
type Mode = (typeof modes)[number];
const invoke = (provider: ReturnType<typeof makeProviderDataPlane>, mode: Mode) =>
  Effect.scoped(
    mode === "run" ? provider.run(spec).pipe(Effect.asVoid) : provider.runStream(spec).pipe(Stream.runDrain),
  );

const redactionForTest = async () => {
  const service = makeRedactionService();
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  // Registration after retaining the redactor must still be observed at failure time.
  await Effect.runPromise(service.registerValues([secret]));
  return redactor;
};

const assertIdentity = async (error: unknown, original: ProviderError) => {
  expect(error).toBeInstanceOf(original.constructor);
  if (!(error instanceof original.constructor)) throw new Error("Expected canonical error class");
  const typed = error as ProviderError;
  expect(typed._tag).toBe(original._tag);
  expect(typed.message).toBe("Failed [redacted]");
  expect(typed.remediation).toBe("Retry safely [redacted]");
  expect("operation" in typed ? typed.operation : undefined).toBe("fixture.original");
  expect("cause" in typed ? typed.cause : undefined).toBe(debugCause);
  const diagnostic = taggedErrorJson(typed);
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(diagnostic).not.toHaveProperty("cause");
  expect(diagnostic).not.toHaveProperty("stack");
  expect(diagnostic).toMatchObject({ details: { nested: ["[redacted]", { value: "[redacted]" }] } });
  const envelope = await Effect.runPromise(
    encodeCommandResult({
      command: "fixture",
      resultSchema: Schema.Unknown,
      outcome: { _tag: "failure", error: typed, additionalErrors: [] },
      redactor: identityRedactor,
    }),
  );
  expect(envelope).not.toContain(secret);
  expect(JSON.parse(envelope).error).toEqual(diagnostic);
  const yielded = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        return yield* typed;
      }),
    ),
  );
  expect(Result.isFailure(yielded) ? yielded.failure : undefined).toBe(typed);
};

for (const mode of modes) {
  test.each(["create", "start", "attach", "logs", "wait", "inspect", "remove"] as const)(
    `${mode} preserves typed provider identity at %s ingress`,
    async (phase) => {
      const original = new ProviderUnavailableError(fields);
      let removals = 0;
      const api: DataPlaneApiClient = {
        request: (input) => {
          const current =
            input.method === "DELETE"
              ? "remove"
              : input.path.includes("/create?")
                ? "create"
                : input.path.endsWith("/json")
                  ? "inspect"
                  : input.path.endsWith("/wait")
                    ? "wait"
                    : "start";
          if (current === "remove") removals++;
          if (current === phase) return Effect.fail(original);
          return Effect.succeed({
            status: current === "remove" ? 204 : 201,
            body: current === "inspect" ? '{"State":{"ExitCode":0}}' : "{}",
          });
        },
        stream: (input) => (input.path.includes(`/${phase}?`) ? Stream.fail(original) : Stream.empty),
      };
      const provider = makeProviderDataPlane({
        providerId: "test",
        api,
        capabilities: { volumeSnapshot: "none" },
        redactor: await redactionForTest(),
      });
      const work =
        phase === "attach"
          ? Effect.scoped(
              mode === "run"
                ? provider
                    .run({ ...spec, stdinStream: { async *[Symbol.asyncIterator]() {} } })
                    .pipe(Effect.asVoid)
                : provider
                    .runStream({ ...spec, stdinStream: { async *[Symbol.asyncIterator]() {} } })
                    .pipe(Stream.runDrain),
            )
          : invoke(provider, mode);
      const exit = await Effect.runPromiseExit(work);
      if (!Exit.isFailure(exit)) throw new Error("Expected typed failure");
      expect(removals).toBe(phase === "create" ? 0 : 1);
      const reason = exit.cause.reasons.find(
        (reason) => Cause.isFailReason(reason) || Cause.isDieReason(reason),
      );
      if (reason === undefined || Cause.isInterruptReason(reason)) throw new Error("Expected failure reason");
      // Stream finalizers convert typed cleanup errors to defects without losing the error.
      expect(reason._tag).toBe(phase === "remove" && mode === "runStream" ? "Die" : "Fail");
      if (phase === "remove")
        expect(Context.getOrUndefined(Cause.reasonAnnotations(reason), FailureRoleAnnotation)).toBe(
          "cleanup",
        );
      await assertIdentity(Cause.isFailReason(reason) ? reason.error : reason.defect, original);
    },
  );

  test.each([
    new ProviderCapabilityError({
      ...fields,
      capability: secret,
      requiredValue: { value: secret },
      actualValue: secret,
    }),
    new ServiceExecError({ ...fields, service: secret }),
    new VolumeOperationError({ ...fields, store: secret }),
  ])(`${mode} preserves alternate canonical provider class $_tag`, async (original) => {
    const provider = makeProviderDataPlane({
      providerId: "test",
      api: { request: () => Effect.fail(original) },
      capabilities: { volumeSnapshot: "none" },
      redactor: await redactionForTest(),
    });
    const exit = await Effect.runPromiseExit(invoke(provider, mode));
    if (!Exit.isFailure(exit)) throw new Error("Expected failure");
    const reason = exit.cause.reasons.find(Cause.isFailReason);
    await assertIdentity(reason?.error, original);
  });

  test.each(["primary", "cleanup"] as const)(
    `${mode} keeps provider-valued and arbitrary defects at %s`,
    async (phase) => {
      const defect = phase === "primary" ? new ProviderUnavailableError(fields) : { private: secret };
      let removals = 0;
      const provider = makeProviderDataPlane({
        providerId: "test",
        capabilities: { volumeSnapshot: "none" },
        redactor: await redactionForTest(),
        api: {
          request: (input) => {
            if (input.method === "DELETE") {
              removals++;
              return phase === "cleanup" ? Effect.die(defect) : Effect.succeed({ status: 204, body: "" });
            }
            if (input.path.endsWith("/json"))
              return phase === "primary"
                ? Effect.die(defect)
                : Effect.succeed({ status: 200, body: '{"State":{"ExitCode":0}}' });
            return Effect.succeed({ status: 201, body: "{}" });
          },
          stream: () => Stream.empty,
        },
      });
      const exit = await Effect.runPromiseExit(invoke(provider, mode));
      if (!Exit.isFailure(exit)) throw new Error("Expected defect");
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBe(defect);
      expect(removals).toBe(1);
    },
  );

  test(`${mode} retains primary and annotated cleanup errors in order`, async () => {
    const primary = new ProviderUnavailableError(fields);
    const cleanup = new ServiceExecError({ ...fields, operation: "cleanup.original", service: secret });
    const provider = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "none" },
      redactor: await redactionForTest(),
      api: {
        request: (input) =>
          input.method === "DELETE"
            ? Effect.failCause(annotateFailureRole(Cause.fail(cleanup), "rollback"))
            : input.path.endsWith("/start")
              ? Effect.fail(primary)
              : Effect.succeed({ status: 201, body: "{}" }),
      },
    });
    const exit = await Effect.runPromiseExit(invoke(provider, mode));
    if (!Exit.isFailure(exit)) throw new Error("Expected failure");
    const projection = failureOutcomeFromCause(exit.cause);
    expect(projection.additionalErrors).toHaveLength(1);
    expect(projection.additionalErrors[0]?.role).toBe("rollback");
    expect(projection.additionalErrors[0]?.error).toBeInstanceOf(ServiceExecError);
    await assertIdentity(projection.error, primary);
    expect(
      JSON.stringify({
        primary: taggedErrorJson(projection.error),
        additional: projection.additionalErrors.map(({ error }) => taggedErrorJson(error)),
      }),
    ).not.toContain(secret);
  });

  test.each(["create", "start", "wait", "inspect", "remove"] as const)(
    `${mode} omits untrusted HTTP bodies at %s with a passthrough redactor`,
    async (phase) => {
      const provider = makeProviderDataPlane({
        providerId: "test",
        capabilities: { volumeSnapshot: "none" },
        redactor: { redactString: (value) => value, redactValue: (value) => value },
        api: {
          request: (input) => {
            const current =
              input.method === "DELETE"
                ? "remove"
                : input.path.includes("/create?")
                  ? "create"
                  : input.path.endsWith("/json")
                    ? "inspect"
                    : input.path.endsWith("/wait")
                      ? "wait"
                      : "start";
            return Effect.succeed(
              current === phase
                ? { status: 500, body: "unregistered-private-http-body" }
                : {
                    status: current === "remove" ? 204 : 201,
                    body: current === "inspect" ? '{"State":{"ExitCode":0}}' : "{}",
                  },
            );
          },
          stream: () => Stream.empty,
        },
      });
      const exit = await Effect.runPromiseExit(invoke(provider, mode));
      if (!Exit.isFailure(exit)) throw new Error("Expected failure");
      const json = JSON.stringify(taggedErrorJson(failureOutcomeFromCause(exit.cause).error));
      for (const value of [
        "unregistered-private-http-body",
        "unregistered-private-argv",
        "unregistered-private-env",
      ])
        expect(json).not.toContain(value);
      expect(json).toContain('"status":500');
    },
  );

  test.each([
    "unregistered-private-malformed-json",
    '{"State":{"ExitCode":"unregistered-private-exit-code"}}',
  ])(`${mode} fails closed without raw inspection parser diagnostics: %s`, async (body) => {
    let removals = 0;
    const provider = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "none" },
      redactor: { redactString: (value) => value, redactValue: (value) => value },
      api: {
        request: (input) => {
          if (input.method === "DELETE") removals++;
          return Effect.succeed({
            status: input.method === "DELETE" ? 204 : 201,
            body: input.path.endsWith("/json") ? body : "{}",
          });
        },
        stream: () => Stream.empty,
      },
    });
    const exit = await Effect.runPromiseExit(invoke(provider, mode));
    if (!Exit.isFailure(exit)) throw new Error("Expected failure");
    const error = failureOutcomeFromCause(exit.cause).error;
    expect(error).toBeInstanceOf(ProviderInternalError);
    expect(error).toMatchObject({ operation: "run.inspect" });
    expect(JSON.stringify(taggedErrorJson(error))).not.toContain("unregistered-private");
    expect(error).not.toHaveProperty("cause");
    expect(removals).toBe(1);
  });

  test.each(["request", "stream"] as const)(
    `${mode} reports a missing %s client as provider unavailable`,
    async (client) => {
      let removals = 0;
      const provider = makeProviderDataPlane({
        providerId: "test",
        capabilities: { volumeSnapshot: "none" },
        redactor: await redactionForTest(),
        api:
          client === "request"
            ? {}
            : {
                request: (input) => {
                  if (input.method === "DELETE") removals++;
                  return Effect.succeed({ status: 201, body: "{}" });
                },
              },
      });
      const exit = await Effect.runPromiseExit(invoke(provider, mode));
      if (!Exit.isFailure(exit)) throw new Error("Expected failure");
      expect(failureOutcomeFromCause(exit.cause).error).toBeInstanceOf(ProviderUnavailableError);
      expect(removals).toBe(client === "request" ? 0 : 1);
    },
  );
}

test("helper acquisition preserves typed identity before any container is created", async () => {
  const original = new ProviderUnavailableError(fields);
  let requests = 0;
  const provider = makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "native" },
    redactor: await redactionForTest(),
    pullHelperImage: () => Effect.fail(original),
    api: {
      request: () => {
        requests++;
        return Effect.succeed({ status: 201, body: "{}" });
      },
    },
  });
  const exit = await Effect.runPromiseExit(
    Effect.scoped(provider.snapshotVolume({ volume: { app: AppId.make("fixture"), store: "data" } })),
  );
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  const wrapper = failureOutcomeFromCause(exit.cause).error;
  expect(wrapper).toBeInstanceOf(VolumeOperationError);
  if (!(wrapper instanceof VolumeOperationError)) throw new Error("Expected snapshot wrapper");
  await assertIdentity(wrapper.cause, original);
  expect(requests).toBe(0);
});

test("helper digest proof failure omits untrusted observed image metadata", async () => {
  const provider = makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "native" },
    redactor: { redactString: (value) => value, redactValue: (value) => value },
    pullHelperImage: () =>
      Effect.succeed({ ref: "unregistered-private-ref", digest: "unregistered-private-digest" }),
    api: {},
  });
  const exit = await Effect.runPromiseExit(
    Effect.scoped(provider.snapshotVolume({ volume: { app: AppId.make("fixture"), store: "data" } })),
  );
  if (!Exit.isFailure(exit)) throw new Error("Expected failure");
  const wrapper = failureOutcomeFromCause(exit.cause).error;
  if (!(wrapper instanceof VolumeOperationError)) throw new Error("Expected snapshot wrapper");
  expect(JSON.stringify(wrapper.cause)).not.toContain("unregistered-private");
});

for (const mode of modes) {
  test.each([
    "missing-request",
    "missing-stream",
    "http",
    "malformed",
    "missing-exit",
    "cleanup-http",
    "nonzero-cleanup",
    "volume-owner",
  ] as const)(
    `${mode} redacts registered default and short values in locally generated %s errors`,
    async (phase) => {
      const service = makeRedactionService();
      const redactor = await Effect.runPromise(service.forProfile("secrets"));
      const tokens = ["lando", "test", "run", "truncated"];
      await Effect.runPromise(service.registerValues(tokens));
      let removals = 0;
      const api: DataPlaneApiClient = {
        ...(phase === "missing-request"
          ? {}
          : ({
              request: (input) => {
                if (input.method === "DELETE") {
                  removals++;
                  return Effect.succeed({
                    status: phase === "cleanup-http" || phase === "nonzero-cleanup" ? 500 : 204,
                    body: "unregistered-private-http-body",
                  });
                }
                return Effect.succeed({
                  status: phase === "http" ? 500 : 201,
                  body: input.path.endsWith("/json")
                    ? phase === "malformed"
                      ? "unregistered-private-malformed"
                      : phase === "missing-exit"
                        ? "{}"
                        : JSON.stringify({ State: { ExitCode: phase === "nonzero-cleanup" ? 7 : 0 } })
                    : "{}",
                });
              },
            } satisfies Pick<DataPlaneApiClient, "request">)),
        ...(phase === "missing-stream" ? {} : { stream: () => Stream.empty }),
      };
      const provider = makeProviderDataPlane({
        providerId: "test",
        api,
        redactor,
        capabilities: { volumeSnapshot: "none" },
      });
      const workSpec =
        phase === "volume-owner"
          ? {
              ...spec,
              mounts: [
                {
                  type: "volume" as const,
                  store: "test",
                  target: PortablePath.make("/data"),
                  readOnly: false,
                },
              ],
            }
          : spec;
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          mode === "run"
            ? provider.run(workSpec).pipe(Effect.asVoid)
            : provider.runStream(workSpec).pipe(Stream.runDrain),
        ),
      );
      if (!Exit.isFailure(exit)) throw new Error("Expected local failure");
      const projection = failureOutcomeFromCause(exit.cause);
      const errors = [projection.error, ...projection.additionalErrors.map(({ error }) => error)];
      for (const error of errors) {
        const diagnostic = taggedErrorJson(error);
        for (const token of tokens) expect(JSON.stringify(diagnostic)).not.toContain(token);
        expect(diagnostic.remediation).toContain("[redacted]");
        if (
          !(
            error instanceof ProviderUnavailableError ||
            error instanceof ProviderInternalError ||
            error instanceof VolumeOperationError
          )
        )
          throw new Error("Expected canonical error");
        for (const field of [
          error.providerId,
          error.operation,
          error.message,
          error.remediation,
          JSON.stringify(error.details),
        ]) {
          for (const token of tokens) expect(field ?? "").not.toContain(token);
        }
        expect(error).toMatchObject({ remediation: diagnostic.remediation });
      }
      expect(removals).toBe(
        phase === "missing-request" || phase === "http" || phase === "volume-owner" ? 0 : 1,
      );
      const envelope = await Effect.runPromise(
        encodeCommandResult({
          command: "fixture",
          resultSchema: Schema.Unknown,
          outcome: projection,
          redactor: identityRedactor,
        }),
      );
      for (const token of tokens) expect(envelope).not.toContain(token);
      if (phase === "nonzero-cleanup") expect(projection.error).toMatchObject({ details: { exitCode: 7 } });
    },
  );
}

test.each(["missing", "digest"] as const)(
  "helper %s proof redacts local fields before a non-ephemeral wrapper retains its cause",
  async (mode) => {
    const service = makeRedactionService();
    const redactor = await Effect.runPromise(service.forProfile("secrets"));
    await Effect.runPromise(service.registerValues(["lando", "test"]));
    const provider = makeProviderDataPlane({
      providerId: "test",
      capabilities: { volumeSnapshot: "native" },
      redactor,
      ...(mode === "missing"
        ? {}
        : { pullHelperImage: () => Effect.succeed({ ref: "untrusted", digest: "untrusted" }) }),
      api: {},
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(provider.snapshotVolume({ volume: { app: AppId.make("fixture"), store: "data" } })),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected helper failure");
    const wrapper = failureOutcomeFromCause(exit.cause).error;
    if (!(wrapper instanceof VolumeOperationError)) throw new Error("Expected unchanged snapshot wrapper");
    const diagnostic = taggedErrorJson(wrapper.cause);
    for (const token of ["lando", "test"]) expect(JSON.stringify(diagnostic)).not.toContain(token);
    expect(diagnostic.remediation).toContain("[redacted]");
  },
);
