import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";

import { StartFailureLogRedactor } from "@lando/container-runtime/redact";
import { resetRegisteredRedactionValuesForTesting } from "@lando/redaction/service";

import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

test("start supplies a canonical redactor with registered plan secrets to provider apply", async () => {
  const password = "opaque-start-log-password";
  const plannedApp = {
    ...plan,
    services: { [web.name]: { ...web, environment: { DATABASE_PASSWORD: password } } },
  };
  let captured: string | undefined;
  const harness = makeHarness({
    plannedApp,
    applyEffect: Effect.gen(function* () {
      const redactor = yield* StartFailureLogRedactor;
      captured = redactor.redactString(`failed with ${password}`);
      return { changed: true };
    }),
  });

  await Effect.runPromise(
    startApp(
      {},
      {
        plan: plannedApp,
        root: plannedApp.root,
        app: { kind: "user", id: plannedApp.id, root: plannedApp.root },
      },
    ).pipe(Effect.provide(harness.layer)),
  );

  expect(captured).toBe("failed with [redacted]");
});
