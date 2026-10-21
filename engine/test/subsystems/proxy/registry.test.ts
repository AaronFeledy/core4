import { expect, test } from "bun:test";
import { ConfigError, ProxyError } from "@lando/sdk/errors";
import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect, Layer, Result } from "effect";
import {
  type RouterServiceRegistration,
  makeRouterServiceRegistry,
} from "../../../src/subsystems/proxy/registry.ts";

const first: RouterServiceRegistration = {
  id: "same",
  defaultFor: { platform: ["linux"] },
  layer: Layer.succeed(RouterService, makeTestRouterService()),
};
const last: RouterServiceRegistration = {
  id: "same",
  layer: Layer.succeed(RouterService, makeTestRouterService()),
};

test("preserves config failures during router selection", async () => {
  const error = new ConfigError({
    message: "Invalid global configuration.",
    path: "/tmp/config.yml",
    issues: [{ path: ["router", "httpPort"], message: "Invalid port." }],
    remediation: "Run `lando config validate`.",
  });
  const registry = makeRouterServiceRegistry({
    registrations: [first],
    configured: Effect.fail(error),
    platform: "linux",
  });
  const result = await Effect.runPromise(Effect.result(registry.select()));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBe(error);
});

test("raw duplicate router ids select the last explicitly and the first on platform fallback", async () => {
  const registry = makeRouterServiceRegistry({
    registrations: [first, last],
    configured: Effect.succeed(undefined),
    platform: "linux",
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        explicitSelectsLast: (yield* registry.select({ explicit: "same" })) === last,
        platformSelectsFirst: (yield* registry.select()) === first,
      };
    }),
  );
  expect(result).toEqual({ explicitSelectsLast: true, platformSelectsFirst: true });
});

test("configured duplicate router id also selects the last registration", async () => {
  const registry = makeRouterServiceRegistry({
    registrations: [first, last],
    configured: Effect.succeed("same"),
    platform: "linux",
  });
  expect(await Effect.runPromise(registry.select())).toBe(last);
});

test("missing configured router id fails rather than using the platform default", async () => {
  const registry = makeRouterServiceRegistry({
    registrations: [first, last],
    configured: Effect.succeed("missing"),
    platform: "linux",
  });
  expect(await Effect.runPromise(registry.select().pipe(Effect.result))).toEqual(
    Result.fail(
      new ProxyError({
        message: "Router service missing is not installed.",
        proxyId: "missing",
        remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
      }),
    ),
  );
});
