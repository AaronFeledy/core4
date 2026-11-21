import { beforeEach, describe, expect, test } from "bun:test";
import { makeRedactionService } from "@lando/redaction/service";
import { ProviderUnavailableError, ServiceExecError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect, Stream } from "effect";

import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { exec } from "../src/podman/exec-transport.ts";
import {
  ATTACH_CONNECTION_RESET_SUBSTRING,
  CRUN_OOM_SCORE_ADJ_ISSUE_URL,
  CRUN_OOM_SCORE_ADJ_REMEDIATION,
  CRUN_OOM_SCORE_ADJ_SUBSTRING,
  failureMentionsAttachConnectionReset,
  failureMentionsCrunOomScoreAdj,
} from "../src/podman/oci-runtime-floor.ts";
import { ContainerTransportError } from "../src/transport.ts";
import { installNonCompensatingExecUmask } from "./support/exec-umask.ts";

const ctx = {
  providerId: "podman",
  remediation: "Run `lando setup` and retry.",
  env: {},
  get redactor() {
    return Effect.runSync(fixtureRedaction.forProfile("secrets"));
  },
} as const;

let fixtureRedaction = makeRedactionService();
beforeEach(() => {
  fixtureRedaction = makeRedactionService();
});

const providerId = ProviderId.make("lando");
const appId = AppId.make("exec-crun-app");
const serviceName = ServiceName.make("web");
const containerName = "lando-exec-crun-app--web";
const createPath = `/containers/${containerName}/exec` as const;
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-08-22T00:00:00Z"),
  source: "container-runtime/exec-crun-oom-score.test.ts",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Exec Crun App",
  slug: "exec-crun-app",
  root: AbsolutePath.make("/tmp/exec-crun-app"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const target = { app: appId, service: serviceName };

const attachFrame = (kind: 1 | 2, value: string): Uint8Array => {
  const payload = new TextEncoder().encode(value);
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  return frame;
};

const resetFailure = new ProviderUnavailableError({
  providerId: "lando",
  operation: "podman-api",
  message: "attach reset",
  cause: new ContainerTransportError({
    kind: "read",
    operation: "podman-api",
    message: "attach reset",
    systemCode: "ECONNRESET",
  }),
  remediation: "Install or start the `lando` provider and confirm it can perform `podman-api`.",
});

const oneChunkStdin = async function* (): AsyncIterable<Uint8Array> {
  yield new Uint8Array([0x61]);
};

const makeExecApi = (options: {
  readonly frames?: readonly Uint8Array[];
  readonly error?: ProviderUnavailableError;
  readonly inspect?: "finished" | "running" | "failed";
  readonly head?: boolean;
  readonly startError?: ProviderUnavailableError;
}): EngineHttpApi => {
  const api: EngineHttpApi = {
    request: (input: EngineHttpRequest) =>
      input.path === createPath
        ? Effect.succeed({ status: 201, body: JSON.stringify({ Id: "exec-1" }) })
        : options.inspect === "failed"
          ? Effect.fail(
              new ProviderUnavailableError({
                providerId: "lando",
                operation: "exec",
                message: "inspect failed",
                remediation: "Install or start the `lando` provider and confirm it can perform `exec`.",
              }),
            )
          : Effect.succeed({
              status: 200,
              body: JSON.stringify({
                Running: options.inspect === "running",
                ExitCode: 255,
              }),
            }),
    stream: (input) =>
      Stream.suspend(() => {
        if (options.startError !== undefined) return Stream.fail(options.startError);
        if (options.head !== false) input.onResponseHead?.();
        return Stream.fromIterable(options.frames ?? []).pipe(
          Stream.concat(options.error === undefined ? Stream.empty : Stream.fail(options.error)),
        );
      }),
  };
  installNonCompensatingExecUmask(api);
  return api;
};

const runExec = (api: EngineHttpApi) =>
  Effect.runPromise(
    exec(plan, target, { command: ["true"], stdinStream: oneChunkStdin() }, { api, ctx }).pipe(Effect.flip),
  );

describe("crun oom_score_adj exec classification", () => {
  test("matches the substring in wrapping text, not one exact message", () => {
    expect(failureMentionsCrunOomScoreAdj("crun: write to /proc/self/oom_score_adj: Permission denied")).toBe(
      true,
    );
    expect(
      failureMentionsCrunOomScoreAdj(
        "Error: OCI runtime error: crun: write to /proc/self/oom_score_adj: Permission denied\n",
      ),
    ).toBe(true);
    expect(failureMentionsCrunOomScoreAdj(`wrapper ${CRUN_OOM_SCORE_ADJ_SUBSTRING} tail`)).toBe(true);
    expect(failureMentionsCrunOomScoreAdj("connection reset by peer")).toBe(false);
    expect(
      failureMentionsAttachConnectionReset(`read unixpacket: ${ATTACH_CONNECTION_RESET_SUBSTRING}`),
    ).toBe(true);
  });

  test("maps a stderr substring to the typed crun remediation", async () => {
    const api = makeExecApi({
      frames: [attachFrame(2, "crun: write to /proc/self/oom_score_adj: Permission denied\n")],
      error: resetFailure,
    });

    const error = await runExec(api);

    expect(error).toBeInstanceOf(ServiceExecError);
    if (!(error instanceof ServiceExecError)) throw new Error("Expected ServiceExecError");
    expect(error.remediation).toBe(CRUN_OOM_SCORE_ADJ_REMEDIATION);
    expect(error.message).toContain(CRUN_OOM_SCORE_ADJ_SUBSTRING);
    expect(error.message).toContain(CRUN_OOM_SCORE_ADJ_ISSUE_URL);
    expect(error.details).toMatchObject({
      reason: CRUN_OOM_SCORE_ADJ_SUBSTRING,
    });
  });

  test("treats a companion attach connection reset on the same failure as part of it", async () => {
    const wrapped = new ProviderUnavailableError({
      providerId: "lando",
      operation: "podman-api",
      message: `read unixpacket @->/proc/self/fd/15/attach: ${ATTACH_CONNECTION_RESET_SUBSTRING}`,
      cause: new ContainerTransportError({
        kind: "read",
        operation: "podman-api",
        message: ATTACH_CONNECTION_RESET_SUBSTRING,
        systemCode: "ECONNRESET",
      }),
      remediation: "Install or start the `lando` provider and confirm it can perform `podman-api`.",
    });
    const api = makeExecApi({
      frames: [attachFrame(2, "OCI runtime attempted write to /proc/self/oom_score_adj\n")],
      error: wrapped,
    });

    const error = await runExec(api);

    expect(error).toBeInstanceOf(ServiceExecError);
    if (!(error instanceof ServiceExecError)) throw new Error("Expected ServiceExecError");
    expect(error.remediation).toBe(CRUN_OOM_SCORE_ADJ_REMEDIATION);
    expect(error.details).toMatchObject({ companion: ATTACH_CONNECTION_RESET_SUBSTRING });
  });

  test("does not recover a companion reset as a successful attach-reset exec", async () => {
    const api = makeExecApi({
      frames: [attachFrame(2, "crun: write to /proc/self/oom_score_adj: Permission denied\n")],
      error: resetFailure,
      inspect: "finished",
    });

    const error = await runExec(api);

    expect(error).toBeInstanceOf(ServiceExecError);
    if (!(error instanceof ServiceExecError)) throw new Error("Expected ServiceExecError");
    expect(error.remediation).toBe(CRUN_OOM_SCORE_ADJ_REMEDIATION);
  });

  test("classifies an HTTP start body that mentions the substring", async () => {
    const startError = new ProviderUnavailableError({
      providerId: "lando",
      operation: "engine.stream",
      message: "Container runtime stream request failed with HTTP 500.",
      details: {
        status: 500,
        body: "crun: write to /proc/self/oom_score_adj: Permission denied",
      },
      remediation: "Run lando doctor.",
    });
    const api = makeExecApi({ startError });

    const error = await Effect.runPromise(
      exec(plan, target, { command: ["true"] }, { api, ctx }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(ServiceExecError);
    if (!(error instanceof ServiceExecError)) throw new Error("Expected ServiceExecError");
    expect(error.remediation).toBe(CRUN_OOM_SCORE_ADJ_REMEDIATION);
  });
});
