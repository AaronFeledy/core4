import { expect, test } from "bun:test";
import type { AppPlan } from "@lando/sdk/schema";
import { UrlScanner } from "@lando/sdk/services";
import { makeTestUrlScanner } from "@lando/sdk/test";
import { Effect, Stream } from "effect";
import { startApp } from "../../src/operations/start.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

test.each(["ready", "lando-error"] as const)(
  "start's selected provider supplies listener evidence only for %s",
  async (verdict) => {
    const plannedApp: AppPlan = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          endpoints: [
            {
              _tag: "published",
              protocol: "http",
              port: 3000,
              primary: true,
              publication: { hostPort: 3000 },
            },
          ],
        },
      },
    };
    let observations = 0;
    const harness = makeHarness({
      plannedApp,
      providerOverrides: {
        execStream: (target) => {
          observations++;
          expect(target).toMatchObject({ app: plan.id, service: web.name, plan: { id: plan.id } });
          return Stream.make(
            {
              kind: "stdout" as const,
              chunk: new TextEncoder().encode(
                "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n" +
                  "0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n",
              ),
            },
            { exitCode: 0 },
          );
        },
      },
    });
    const scanner = makeTestUrlScanner();
    const result = await Effect.runPromise(
      startApp(
        {},
        {
          plan: plannedApp,
          root: plan.root,
          app: { kind: "user", id: plan.id, root: plan.root },
        },
      ).pipe(
        Effect.provideService(UrlScanner, {
          ...scanner,
          scan: (appId, options) =>
            Effect.succeed({
              appId,
              endpoints: (options?.urls ?? []).map((target) => ({
                ...target,
                reachable: verdict === "ready",
                verdict,
                ...(verdict === "ready" ? { statusCode: 200 } : { detail: "connection refused" }),
              })),
            }),
        }),
        Effect.provide(harness.layer),
      ),
    );
    expect(observations).toBe(verdict === "ready" ? 0 : 1);
    expect(result.checks?.[0]?.listener).toEqual(
      verdict === "ready"
        ? undefined
        : {
            service: "web",
            port: 3000,
            transport: "tcp",
            basis: "primary-endpoint",
            state: "loopback-only",
            listening: [{ port: 3000, address: "127.0.0.1" }],
          },
    );
    expect(byTag(harness.events, "message.warn").map((event) => event.body)).toEqual(
      verdict === "ready"
        ? []
        : [
            "Lando could not reach http://localhost:3000/: connection refused. Only loopback TCP bindings observed on 3000, so other services can't reach it. Bind it to all interfaces (0.0.0.0) instead of loopback.",
          ],
    );
  },
);
