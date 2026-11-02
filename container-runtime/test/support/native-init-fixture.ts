import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  type EngineHttpApi,
  type EngineHttpRequest,
  buildContainerRemoveRequest,
} from "../../src/engine-api.ts";

/** Tiny existing image only — never a multi-service runtime stack. */
export const NATIVE_INIT_IMAGE = "docker.io/library/busybox:1.37" as const;

export const NATIVE_INIT_CASE_IDS = [
  "direct-term",
  "handler-marker",
  "orphan-reaping",
  "init-false",
  "compose-omitted",
  "nonforwarding-wrapper",
] as const;

export type NativeInitCaseId = (typeof NATIVE_INIT_CASE_IDS)[number];

/** Authored init intent realized on the create body (not discovery). */
export type NativeInitIntent = "true" | "false" | "omitted";

const createdId = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ Id: Schema.String })));

export const decodeNativeInitInspect = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      Id: Schema.String,
      State: Schema.Struct({
        Running: Schema.optionalKey(Schema.Boolean),
        ExitCode: Schema.optionalKey(Schema.Number),
        OOMKilled: Schema.optionalKey(Schema.Boolean),
        Status: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
);

export const directTermCommand = ["sleep", "86400"] as const;

export const handlerMarkerCommand = [
  "sh",
  "-c",
  "trap 'echo native-init-marker; exit 0' TERM; touch /tmp/native-init-ready; while :; do sleep 1 & wait $!; done",
] as const;

export const orphanReapingCommand = [
  "sh",
  "-c",
  [
    "trap 'exit 0' TERM",
    "( sleep 86400 & echo $! > /tmp/native-init-orphan )",
    "touch /tmp/native-init-ready",
    "while :; do sleep 1 & wait $!; done",
  ].join("; "),
] as const;

export const nonForwardingWrapperCommand = [
  "sh",
  "-c",
  `trap 'echo native-init-wrapper-term' TERM; setsid sh -c 'trap "echo native-init-descendant-term; exit 0" TERM; touch /tmp/native-init-ready; while :; do sleep 1 & wait $!; done' & while :; do sleep 1 & wait $!; done`,
] as const;

export const commandForCase = (caseId: NativeInitCaseId): readonly string[] => {
  switch (caseId) {
    case "direct-term":
      return directTermCommand;
    case "handler-marker":
      return handlerMarkerCommand;
    case "orphan-reaping":
      return orphanReapingCommand;
    case "init-false":
      return directTermCommand;
    case "compose-omitted":
      return directTermCommand;
    case "nonforwarding-wrapper":
      return nonForwardingWrapperCommand;
    default: {
      const exhaustive: never = caseId;
      return exhaustive;
    }
  }
};

export const intentForCase = (caseId: NativeInitCaseId): NativeInitIntent => {
  switch (caseId) {
    case "direct-term":
    case "handler-marker":
    case "orphan-reaping":
    case "nonforwarding-wrapper":
      return "true";
    case "init-false":
      return "false";
    case "compose-omitted":
      return "omitted";
    default: {
      const exhaustive: never = caseId;
      return exhaustive;
    }
  }
};

/** HostConfig.Init fragment: omitted intent never sends the field (raw Compose parity). */
export const hostConfigInitFragment = (intent: NativeInitIntent): { readonly Init?: boolean } => {
  switch (intent) {
    case "true":
      return { Init: true };
    case "false":
      return { Init: false };
    case "omitted":
      return {};
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
};

export const nativeInitCreateBody = (input: {
  readonly image?: string;
  readonly command: readonly string[];
  readonly intent: NativeInitIntent;
  readonly name: string;
  readonly labels?: Readonly<Record<string, string>>;
}) => ({
  Image: input.image ?? NATIVE_INIT_IMAGE,
  Cmd: [...input.command],
  Labels: { "dev.lando.native-init-fixture": input.name, ...(input.labels ?? {}) },
  HostConfig: {
    NetworkMode: "none",
    AutoRemove: false,
    ...hostConfigInitFragment(input.intent),
  },
});

/**
 * Acquisition ledger for one fixture run. Only successful creates enter the set.
 * Async disposal force-removes exact IDs; never lists or prunes the daemon.
 */
export const nativeInitFixture = (source: EngineHttpApi, runId: string = randomUUID()) => {
  const request = source.request;
  assert.ok(request, "Native init fixture requires an engine request client");
  const name = `native-init-${runId}`;
  const containers = new Set<string>();
  const api: EngineHttpApi = {
    ...source,
    request: (input) =>
      Effect.suspend(() =>
        request(input).pipe(
          Effect.map((response) => {
            if (
              response.status >= 200 &&
              response.status < 300 &&
              input.method === "POST" &&
              input.path.startsWith("/containers/create")
            ) {
              containers.add(createdId(response.body).Id);
            }
            if (input.method === "DELETE" && [200, 204, 404].includes(response.status)) {
              const id = decodeURIComponent(input.path.split("/")[2]?.split("?")[0] ?? "");
              containers.delete(id);
            }
            return response;
          }),
        ),
      ),
  };
  const call = async (input: EngineHttpRequest, accepted: readonly number[] = [200, 201, 204, 304]) => {
    assert.ok(api.request);
    const response = await Effect.runPromise(
      api
        .request({ ...input, signal: input.signal ?? AbortSignal.timeout(30_000) })
        .pipe(Effect.timeout("95 seconds")),
    );
    assert.ok(
      accepted.includes(response.status),
      `${input.method} ${input.path}: HTTP ${response.status}: ${response.body}`,
    );
    return response;
  };
  return {
    api,
    call,
    name,
    runId,
    containers,
    async [Symbol.asyncDispose]() {
      const failures: unknown[] = [];
      const stage = [...containers].map(buildContainerRemoveRequest);
      const results = await Promise.allSettled(stage.map((input) => call(input, [200, 204, 404])));
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length > 0)
        throw new AggregateError(failures, `Native-init fixture cleanup failed for ${name}`);
    },
  };
};
