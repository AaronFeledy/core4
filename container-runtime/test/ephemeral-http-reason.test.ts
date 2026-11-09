import { expect, test } from "bun:test";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { failureOutcomeFromCause, taggedErrorJson } from "@lando/sdk/command-result";
import { AppPlan, PortablePath, ProviderId } from "@lando/sdk/schema";
import { Effect, Exit, Schema, Stream } from "effect";
import type { DataPlaneHttpRequest } from "../src/data-plane.ts";
import { makeProviderPlanState } from "../src/provider-assembly.ts";
import { runtimeDiagnosticContext } from "../src/redact.ts";

const plan = Schema.decodeSync(AppPlan)({
  id: "fixture",
  name: "fixture",
  slug: "fixture",
  root: "/fixture",
  provider: "test",
  services: {},
  routes: [],
  stores: [{ name: "data", scope: "app", kind: "data" }],
  fileSync: [],
  extensions: {},
  identity: { appRoot: "/fixture", ownerKey: "fixture-owner" },
  metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/fixture/.lando.yml", runtime: 4 },
});
const phaseOf = (input: DataPlaneHttpRequest) =>
  input.path === "/volumes/create"
    ? "volume"
    : input.path.includes("/create?")
      ? "create"
      : input.path.endsWith("/start")
        ? "start"
        : input.path.endsWith("/wait")
          ? "wait"
          : "inspect";
const cases: ReadonlyArray<{
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly reason: string;
  readonly visible: string | undefined;
  readonly hidden: readonly string[];
}> = [
  { name: "engine reason", env: {}, reason: "no such image", visible: "no such image", hidden: [] },
  {
    name: "run-local env",
    env: { PRIVATE: "run-local-secret-canary" },
    reason: "denied run-local-secret-canary",
    visible: "denied [redacted]",
    hidden: ["run-local-secret-canary"],
  },
  {
    name: "DSN password",
    env: { DSN: "postgres://operator:dsn-password-canary@db/main" },
    reason: "denied dsn-password-canary",
    visible: "denied [redacted]",
    hidden: ["dsn-password-canary"],
  },
  {
    name: "unsafe numeric value",
    env: { PRIVATE: "42" },
    reason: "failure 42",
    visible: undefined,
    hidden: ["failure 42"],
  },
  {
    name: "late registration",
    env: {},
    reason: "denied late-registered-canary",
    visible: "denied [redacted]",
    hidden: ["late-registered-canary"],
  },
  {
    name: "overlapping values",
    env: { PRIVATE: "token-overlap-canary" },
    reason: "denied token-overlap-canary",
    visible: "denied [redacted]",
    hidden: ["token-overlap-canary", "overlap-canary"],
  },
  {
    name: "host env",
    env: {},
    reason: "denied host-secret-canary",
    visible: "denied [redacted]",
    hidden: ["host-secret-canary"],
  },
  { name: "empty reason", env: {}, reason: " ", visible: undefined, hidden: [] },
  {
    name: "entirely redacted",
    env: { PRIVATE: "whole-reason-canary" },
    reason: "whole-reason-canary",
    visible: undefined,
    hidden: ["whole-reason-canary"],
  },
];

for (const mode of ["run", "runStream"] as const) {
  for (const phase of ["create", "start", "wait", "inspect", "volume"] as const) {
    test.each(cases)(
      `${mode} ${phase} safely reports $name`,
      async ({ name, env, reason, visible, hidden }) => {
        const service = makeRedactionService();
        const ctx = await Effect.runPromise(
          runtimeDiagnosticContext({
            providerId: "test",
            remediation: "fixture",
            env: { PRIVATE_TOKEN: "host-secret-canary" },
          }).pipe(Effect.provideService(RedactionService, service)),
        );
        const state = makeProviderPlanState({
          ctx,
          redactor: ctx.redactor,
          providerId: ProviderId.make("test"),
          providerName: "test",
          capabilities: { volumeSnapshot: "none" },
          load: () => Effect.succeed(undefined),
          persist: () => Effect.void,
          remove: () => Effect.void,
          api: {
            request: (input) =>
              Effect.succeed(
                input.method === "DELETE"
                  ? { status: 204, body: "" }
                  : phaseOf(input) === phase
                    ? { status: 404, body: JSON.stringify({ message: reason }) }
                    : { status: 201, body: input.path.endsWith("/json") ? '{"State":{"ExitCode":0}}' : "{}" },
              ),
            stream: (input) => {
              input.onResponseHead?.();
              return Stream.empty;
            },
          },
        });
        if (state.dataPlane === undefined) throw new Error("Expected assembled data plane");
        await Effect.runPromise(service.registerValues(["late-registered-canary", "overlap-canary"]));
        const spec = {
          image: "fixture",
          command: ["sh", "-c", "true"],
          env,
          ...(phase === "volume"
            ? {
                owner: { app: plan.id, plan },
                mounts: [
                  {
                    type: "volume" as const,
                    store: "data",
                    target: PortablePath.make("/data"),
                    readOnly: false,
                  },
                ],
              }
            : {}),
        };
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            mode === "run"
              ? state.dataPlane.run(spec).pipe(Effect.asVoid)
              : state.dataPlane.runStream(spec).pipe(Stream.runDrain),
          ),
        );
        if (!Exit.isFailure(exit)) throw new Error("Expected HTTP failure");
        const diagnostic = taggedErrorJson(failureOutcomeFromCause(exit.cause).error);
        expect(diagnostic).toMatchObject({
          _tag: "ProviderUnavailableError",
          operation: `run.${phase}`,
          details: { status: 404 },
        });
        for (const value of hidden) expect(JSON.stringify(diagnostic)).not.toContain(value);
        if (visible === undefined) expect(diagnostic.message).toMatch(/\(HTTP 404\)\.$/u);
        else expect(diagnostic.message).toContain(visible);
        if (name === "engine reason") expect(diagnostic.message).not.toContain("[redacted]");
      },
    );
  }
}

test.each([false, true])(
  "helper HTTP reasons are bounded after redaction (service=%s)",
  async (withService) => {
    const service = makeRedactionService();
    const context = runtimeDiagnosticContext({
      providerId: "test",
      remediation: "fixture",
      env: { API_TOKEN: "host-secret-canary" },
    });
    const ctx = await Effect.runPromise(
      withService ? context.pipe(Effect.provideService(RedactionService, service)) : context,
    );
    const secret = "a".repeat(700);
    const state = makeProviderPlanState({
      ctx,
      redactor: ctx.redactor,
      providerId: ProviderId.make("test"),
      providerName: "test",
      capabilities: { volumeSnapshot: "none" },
      load: () => Effect.succeed(undefined),
      persist: () => Effect.void,
      remove: () => Effect.void,
      api: {
        request: () =>
          Effect.succeed({
            status: 500,
            body: JSON.stringify({ cause: `denied ${secret} host-secret-canary ${"é".repeat(800)}` }),
          }),
      },
    });
    if (state.dataPlane === undefined) throw new Error("Expected data plane");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(state.dataPlane.run({ image: "fixture", command: ["true"], env: { PRIVATE: secret } })),
    );
    if (!Exit.isFailure(exit)) throw new Error("Expected failure");
    const diagnostic = taggedErrorJson(failureOutcomeFromCause(exit.cause).error);
    expect(diagnostic.message).toContain("denied [redacted] [redacted]");
    expect(new TextEncoder().encode(diagnostic.message).byteLength).toBeLessThan(650);
    expect(diagnostic.message).not.toContain("a".repeat(100));
    expect(diagnostic.message).not.toContain("host-secret-canary");
    expect(diagnostic.message).not.toContain("�");
  },
);
