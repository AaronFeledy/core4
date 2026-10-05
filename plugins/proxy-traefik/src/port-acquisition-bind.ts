import { createServer } from "node:net";

import { Duration, Effect } from "effect";

import { runProbe } from "@lando/sdk/probe";
import { createRedactor } from "@lando/sdk/secrets";

import { probeHttp, probeTcp } from "./loopback-probe.ts";
import type { BindOutcome, ForwardOutcome } from "./port-acquisition.ts";

const secretsRedactor = createRedactor("secrets");

const errnoCode = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
};

const classifyBindError = (error: unknown): BindOutcome => {
  const code = errnoCode(error);
  if (code === "EADDRINUSE") return { kind: "EADDRINUSE", code: "EADDRINUSE" };
  if (code === "EACCES" || code === "EPERM") return { kind: "EACCES", code };
  return { kind: "other-error", ...(code === undefined ? {} : { code }) };
};

const isBindOutcome = (value: unknown): value is BindOutcome => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = value.kind;
  return kind === "success" || kind === "EADDRINUSE" || kind === "EACCES" || kind === "other-error";
};

const isForwardOutcome = (value: unknown): value is ForwardOutcome => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  return value.kind === "success" || value.kind === "failure";
};

const listenOnce = (host: string, port: number): Promise<BindOutcome> =>
  new Promise((resolve) => {
    const server = createServer();
    const finish = (outcome: BindOutcome) => {
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(outcome));
        return;
      }
      resolve(outcome);
    };
    server.once("error", (error) => finish(classifyBindError(error)));
    server.listen(port, host, () => finish({ kind: "success" }));
  });

export const probeBind = Effect.fn("TraefikRouter.probeBind")(function* (
  host: string,
  port: number,
): Effect.fn.Return<BindOutcome> {
  let last: BindOutcome = { kind: "other-error" };
  yield* runProbe(
    {
      id: "proxy-traefik-bind",
      policy: { maxAttempts: 3, delay: Duration.millis(25) },
      classify: {
        success: (value) => {
          if (isBindOutcome(value)) last = value;
          return last.kind === "other-error" ? "yellow" : "green";
        },
        failure: (error) => {
          last = classifyBindError(secretsRedactor.redactValue(error));
          return last.kind === "other-error" ? "yellow" : "green";
        },
      },
    },
    Effect.tryPromise({
      try: () => listenOnce(host, port),
      catch: (error) => error,
    }),
  ).pipe(Effect.catch(() => Effect.void));
  return last;
});

export const probeTcpOpen = (host: string, port: number): Effect.Effect<boolean> =>
  Effect.promise(() => probeTcp({ host, port, timeoutMs: 200 }).then((result) => result === "open"));

export type ForwardProbeRole = "http" | "https";

export const probeForward = Effect.fn("TraefikRouter.probeForward")(function* (
  host: string,
  port: number,
  role: ForwardProbeRole,
): Effect.fn.Return<ForwardOutcome> {
  let last: ForwardOutcome = { kind: "failure" };
  yield* runProbe(
    {
      id: "proxy-traefik-forward",
      policy: { maxAttempts: 3, delay: Duration.millis(50), timeout: Duration.millis(1000) },
      classify: {
        success: (value) => {
          if (isForwardOutcome(value)) last = value;
          return last.kind === "success" ? "green" : "yellow";
        },
        failure: () => {
          last = { kind: "failure" };
          return "yellow";
        },
      },
    },
    Effect.tryPromise({
      try: async () => {
        const tcp = await probeTcp({ host, port, timeoutMs: 200 });
        if (tcp !== "open") return { kind: "failure" as const };
        return {
          kind: (await probeHttp({ host, port, role, timeoutMs: 500 }))
            ? ("success" as const)
            : ("failure" as const),
        };
      },
      catch: (error) => error,
    }),
  ).pipe(Effect.catch(() => Effect.void));
  return last;
});
