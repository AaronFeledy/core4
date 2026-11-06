import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { ScratchAppService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { withStartupFixture } from "./startup-fixture.ts";

test("scratch acquisition readies the runtime before applying its plan", async () => {
  let ready = false;
  await withStartupFixture(
    {
      ensureReady: Effect.sync(() => {
        ready = true;
      }),
      apply: (plan, options) =>
        Effect.suspend(() =>
          ready
            ? TestRuntimeProvider.apply(plan, options)
            : Effect.fail(
                new ProviderUnavailableError({
                  providerId: "lando",
                  operation: "apply",
                  message: "Runtime is powered off",
                  remediation: "Prepare the runtime before applying the plan.",
                }),
              ),
        ),
      inspect: (target) =>
        Effect.succeed({
          app: target.app,
          service: target.service,
          providerId: ProviderId.make("lando"),
          status: "running" as const,
          publications: { status: "unknown" as const },
          containerId: "scratch-web",
        }),
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    },
    async (fixture) => {
      const handle = await Effect.runPromise(
        Effect.flatMap(ScratchAppService, (scratch) =>
          scratch.acquire({ source: { kind: "fork" }, isolate: "none", detached: true }),
        ).pipe(Effect.scoped, Effect.provide(fixture.layer)),
      );
      expect(fixture.entries.get(handle.id)?.status).toBe("running");
    },
  );
});
