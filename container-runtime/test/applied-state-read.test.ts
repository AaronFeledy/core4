import { expect, test } from "bun:test";
import { makeAppliedPlanStore, unreadableAppliedStateError } from "@lando/container-runtime/applied-state";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { Effect } from "effect";

test("an unreadable global record points at global cleanup, not the current app's destroy", () => {
  const read = (appId: string) =>
    unreadableAppliedStateError({
      providerId: "lando",
      path: `/state/${appId}.json`,
      layout: "per-app",
      appId,
    }).remediation;
  // Running `lando destroy` from an app directory would remove that app instead of the global app.
  expect(read("global")).toContain("`lando global:destroy --yes`");
  expect(read("global")).not.toContain("`lando destroy`");
  expect(read("app1")).toContain("`lando destroy`");
});

test("a shared record that is unreadable names the cleanup command for the app being read", async () => {
  // Given a record-layout store whose single file exists but holds no readable record.
  const state: PluginStateStore = {
    open: () =>
      Effect.succeed({
        path: AbsolutePath.make("/tmp/lando-record/applied-plans.json"),
        get: Effect.succeed(null),
        exists: Effect.succeed(true),
        set: () => Effect.die("read-only fixture"),
        update: () => Effect.die("read-only fixture"),
        mutate: () => Effect.die("read-only fixture"),
        transition: () => Effect.die("read-only fixture"),
        modify: () => Effect.die("read-only fixture"),
        remove: Effect.die("read-only fixture"),
      }),
    withLock: (_key, body) => body,
  };
  const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });
  // When the global app's plan is read strictly.
  const failure = await Effect.runPromise(
    Effect.flip(store.loadAppliedPlanStrict(state, AppId.make("global"))),
  );
  // Then the refusal is the strict read error and names global cleanup.
  expect(failure).toMatchObject({ _tag: "ProviderUnavailableError", operation: "applied-state.read" });
  expect(failure.remediation).toContain("`lando global:destroy --yes`");
});
