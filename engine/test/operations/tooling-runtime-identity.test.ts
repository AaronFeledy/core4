import { expect, test } from "bun:test";
import { Effect } from "effect";
import { compileToolingInvocations } from "../../src/operations/tooling-compile.ts";

test("preserves authorized invocation identity outside authored tooling env", () => {
  const compiled = Effect.runSync(
    compileToolingInvocations({
      name: "check",
      lookupKey: "check",
      source: { path: "/app/.lando.yml", task: "check" },
      task: { env: { VALUE: "task" }, cmds: [{ cmd: "echo step", env: { VALUE: "step" } }] },
      env: { LANDO_APP_NAME: "actual-app" },
    }),
  );
  expect(compiled.invocations[0]?.env).toEqual({ VALUE: "step", LANDO_APP_NAME: "actual-app" });
});
