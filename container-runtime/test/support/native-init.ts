import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import type { EngineApiClient, EngineHttpRequest } from "../../src/engine-api.ts";
import {
  NATIVE_INIT_CASE_IDS,
  NATIVE_INIT_IMAGE,
  type NativeInitCaseId,
  commandForCase,
  decodeNativeInitInspect,
  intentForCase,
  nativeInitCreateBody,
  nativeInitFixture,
} from "./native-init-fixture.ts";
import {
  type NativeInitTransport,
  assertNativeInitTransport,
  nativeInitClient,
} from "./native-init-transport.ts";

export {
  NATIVE_INIT_CASE_IDS,
  NATIVE_INIT_IMAGE,
  commandForCase,
  hostConfigInitFragment,
  intentForCase,
  nativeInitCreateBody,
} from "./native-init-fixture.ts";
export {
  type NativeInitTransport,
  assertNativeInitTransport,
  commandTransportArgv,
  nativeInitClient,
} from "./native-init-transport.ts";

type FixtureCall = ReturnType<typeof nativeInitFixture>["call"];
const createdId = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ Id: Schema.String })));
const execState = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ Running: Schema.Boolean, ExitCode: Schema.Number.check(Schema.isInt()) }),
  ),
);

export const nativeInitStopDeadlineMs = (seconds: number): number =>
  seconds * 1000 + Math.max(30_000, seconds * 1000);

const exec = async (call: FixtureCall, id: string, script: string): Promise<number> => {
  const response = await call({
    method: "POST",
    path: `/containers/${id}/exec`,
    body: { AttachStdout: true, AttachStderr: true, Cmd: ["sh", "-c", script] },
  });
  const execId = createdId(response.body).Id;
  await call({ method: "POST", path: `/exec/${execId}/start`, body: { Detach: false, Tty: false } });
  const state = execState((await call({ method: "GET", path: `/exec/${execId}/json` })).body);
  assert.equal(state.Running, false, "fixture exec must finish before its exit status is read");
  return state.ExitCode;
};

const waitFor = async (label: string, predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = performance.now() + 30_000;
  while (!(await predicate())) {
    assert.ok(performance.now() < deadline, `${label} did not synchronize within 30 seconds`);
    await Bun.sleep(100);
  }
};

const ensureImage = async (call: FixtureCall, provider: "docker" | "podman") => {
  const prefix = provider === "podman" ? "/libpod" : "";
  const image = await call(
    { method: "GET", path: `${prefix}/images/${encodeURIComponent(NATIVE_INIT_IMAGE)}/json` },
    [200, 404],
  );
  if (image.status === 200) return;
  const path: EngineHttpRequest["path"] =
    provider === "podman"
      ? `/libpod/images/pull?reference=${encodeURIComponent(NATIVE_INIT_IMAGE)}`
      : `/images/create?fromImage=${encodeURIComponent(NATIVE_INIT_IMAGE)}`;
  await call({ method: "POST", path, signal: AbortSignal.timeout(90_000) });
};

const runCase = async (
  caseId: NativeInitCaseId,
  fixture: ReturnType<typeof nativeInitFixture>,
  graceSeconds: number,
) => {
  const intent = intentForCase(caseId);
  const body = nativeInitCreateBody({
    command: commandForCase(caseId),
    intent,
    name: `${fixture.name}-${caseId}`,
  });
  assert.equal(Object.hasOwn(body.HostConfig, "Init"), intent !== "omitted");
  const id = createdId(
    (await fixture.call({ method: "POST", path: `/containers/create?name=${fixture.name}-${caseId}`, body }))
      .body,
  ).Id;
  const inspect = async () =>
    decodeNativeInitInspect((await fixture.call({ method: "GET", path: `/containers/${id}/json` })).body);
  await fixture.call({ method: "POST", path: `/containers/${id}/start` });
  await waitFor(`${caseId} running`, async () => (await inspect()).State.Running === true);
  if (intent === "true") {
    assert.equal(
      await exec(
        fixture.call,
        id,
        'case "$(cat /proc/1/comm)" in sleep|sh|ash|bash) exit 1;; *) exit 0;; esac',
      ),
      0,
      "Init:true must insert init ahead of the authored sleep or shell",
    );
  }
  if (caseId === "handler-marker" || caseId === "orphan-reaping" || caseId === "nonforwarding-wrapper") {
    await waitFor(
      `${caseId} handler ready`,
      async () => (await exec(fixture.call, id, "test -f /tmp/native-init-ready")) === 0,
    );
  }
  if (caseId === "init-false") {
    assert.equal(
      await exec(fixture.call, id, 'test "$(cat /proc/1/comm)" = sleep'),
      0,
      "init:false must leave the authored process at PID 1",
    );
  }
  if (caseId === "orphan-reaping") {
    assert.equal(
      await exec(
        fixture.call,
        id,
        'pid=$(cat /tmp/native-init-orphan); read p comm state ppid rest < /proc/$pid/stat; test "$ppid" = 1 && kill -TERM "$pid"',
      ),
      0,
      "the orphan must be adopted by init before termination",
    );
    await waitFor(
      "orphan reaped while main lives",
      async () => (await exec(fixture.call, id, "test ! -e /proc/$(cat /tmp/native-init-orphan)/stat")) === 0,
    );
    assert.equal((await inspect()).State.Running, true, "reaping must occur before main process shutdown");
  }
  const began = performance.now();
  await fixture.call({
    method: "POST",
    path: `/containers/${id}/stop?t=${graceSeconds}`,
    signal: AbortSignal.timeout(nativeInitStopDeadlineMs(graceSeconds)),
  });
  const stopElapsedMs = performance.now() - began;
  assert.ok(stopElapsedMs <= nativeInitStopDeadlineMs(graceSeconds), "stop exceeded grace-relative bound");
  const state = (await inspect()).State;
  assert.equal(state.Running, false, `${caseId} must be stopped`);
  const logs = (
    await fixture.call({
      method: "GET",
      path: `/containers/${id}/logs?stdout=true&stderr=true&timestamps=false`,
    })
  ).body;
  switch (caseId) {
    case "direct-term":
      assert.equal(state.ExitCode, 143, "direct child must report TERM completion");
      break;
    case "handler-marker":
      assert.equal(state.ExitCode, 0);
      assert.ok(
        logs.includes("native-init-marker"),
        "actual TERM handler marker is required independently of exit 0",
      );
      break;
    case "nonforwarding-wrapper":
      assert.ok(logs.includes("native-init-wrapper-term"), "init must reach the immediate wrapper");
      assert.ok(
        !logs.includes("native-init-descendant-term"),
        "the intentionally nonforwarding wrapper must not signal its descendant",
      );
      break;
    case "orphan-reaping":
    case "init-false":
    case "compose-omitted":
      break;
    default: {
      const unreachable: never = caseId;
      return unreachable;
    }
  }
  await fixture.call({ method: "DELETE", path: `/containers/${id}?force=true&v=true` }, [200, 204, 404]);
  return { id: caseId, intent, exitCode: state.ExitCode, stopElapsedMs, outcome: "passed" as const };
};

export const runNativeInit = async (
  input: {
    readonly transport: NativeInitTransport;
    readonly stopGraceSeconds?: number;
    readonly platform?: NodeJS.Platform;
  },
  client: EngineApiClient = nativeInitClient(input.transport, input.platform),
) => {
  assertNativeInitTransport(input.transport, input.platform);
  const graceSeconds = input.stopGraceSeconds ?? 10;
  assert.ok(Number.isInteger(graceSeconds) && graceSeconds > 0, "stop grace must be a positive integer");
  await Effect.runPromise(client.info.pipe(Effect.timeout("30 seconds")));
  await using fixture = nativeInitFixture(client);
  await ensureImage(fixture.call, input.transport.provider);
  const cases = [];
  for (const caseId of NATIVE_INIT_CASE_IDS) cases.push(await runCase(caseId, fixture, graceSeconds));
  return {
    outcome: "passed" as const,
    provider: input.transport.provider,
    transportKind: input.transport.kind,
    stopGraceSeconds: graceSeconds,
    cases,
    cleanup: "completed" as const,
  };
};
