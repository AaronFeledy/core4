import { describe, expect, test } from "bun:test";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { assertAdvertisedForward } from "../src/proxy-setup.ts";

describe("assertAdvertisedForward", () => {
  test("waits for both advertised ports when HTTPS binds after HTTP", async () => {
    // Given
    const calls: string[] = [];
    const warnings: string[] = [];
    const check = assertAdvertisedForward(
      {
        probeForward: (_host, _port, role) =>
          Effect.sync(() => {
            calls.push(role);
            return {
              kind:
                role === "http" || calls.filter((call) => call === "https").length > 3
                  ? ("success" as const)
                  : ("failure" as const),
            };
          }),
        events: {
          publish: (event) =>
            Effect.sync(() => {
              if (event._tag === "message.warn" && typeof event.body === "string") warnings.push(event.body);
            }),
        },
      },
      { http: 8080, https: 8443 },
    );
    // When
    const elapsed = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(check);
        yield* TestClock.adjust(750);
        yield* Fiber.join(fiber);
        return yield* Clock.currentTimeMillis;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    // Then
    expect(calls).toEqual(["http", "https", "http", "https", "http", "https", "http", "https"]);
    expect(elapsed).toBe(750);
    expect(warnings).toEqual([]);
  });

  for (const context of ["setup", "revalidation"] as const) {
    test(`warns only at the deadline with ${context} remediation when a port never binds`, async () => {
      // Given
      const warnings: string[] = [];
      const check = assertAdvertisedForward(
        {
          probeForward: (_host, _port, role) =>
            Effect.succeed({ kind: role === "http" ? ("success" as const) : ("failure" as const) }),
          events: {
            publish: (event) =>
              Effect.sync(() => {
                if (event._tag === "message.warn" && typeof event.body === "string")
                  warnings.push(event.body);
              }),
          },
        },
        { http: 8080, https: 8443 },
        context,
      );
      // When
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(check);
          yield* TestClock.adjust(9999);
          expect(warnings).toEqual([]);
          yield* TestClock.adjust(1);
          yield* Fiber.join(fiber);
        }).pipe(Effect.provide(TestClock.layer())),
      );
      // Then
      expect(warnings).toHaveLength(1);
      if (context === "setup") {
        expect(warnings[0]).toContain("`lando doctor`");
        expect(warnings[0]).toContain("`lando global:restart`");
      } else {
        expect(warnings[0]).toContain("`lando global:logs --service=traefik --tail=100`");
        expect(warnings[0]).toContain("`lando global:info`");
        expect(warnings[0]).not.toContain("`lando global:restart`");
      }
    });
  }

  test("probes the HTTPS authority with TLS even when the port is not 443", async () => {
    // Given: occupied-hop advertised 8080/8443.
    const calls: Array<{ readonly port: number; readonly role: string }> = [];

    // When: setup checks advertised forward.
    await Effect.runPromise(
      assertAdvertisedForward(
        {
          probeForward: (_host, port, role) =>
            Effect.sync(() => {
              calls.push({ port, role });
              return { kind: "success" as const };
            }),
        },
        { http: 8080, https: 8443 },
      ),
    );

    // Then: 8443 is probed as https, not plain http.
    expect(calls).toEqual([
      { port: 8080, role: "http" },
      { port: 8443, role: "https" },
    ]);
  });
});
