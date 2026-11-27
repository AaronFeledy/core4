import { expect, test } from "bun:test";
import { ShellExecError } from "@lando/sdk/errors";
import { ShellRunner } from "@lando/sdk/services";
import { Cause, Effect, Exit } from "effect";
import { runBunShellTooling } from "../../src/operations/tooling-bun-script.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
import { withBunScript } from "./tooling-bun-script-support.ts";

test("script-backed tooling reports remediation when the selected ShellRunner is absent", async () => {
  await withBunScript("# ---\n# desc: Runner probe\n# ---\nprintf should-not-run\n", async (root) => {
    const result = await Effect.runPromise(
      runBunShellTooling({ name: "probe" }, root).pipe(
        Effect.provide(testEnvironmentResolverLayer),
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ToolingCompileError",
        tool: "app:probe",
        remediation: "Provide the selected ShellRunner in the host tooling runtime.",
      },
    });
  });
});

test.each(["observed", "typed failure", "mixed cause"] as const)(
  "keeps a script's %s when the signal also aborts",
  async (outcome) => {
    await withBunScript("# ---\n# desc: Runner probe\n# ---\nprintf should-not-run\n", async (root) => {
      const controller = new AbortController();
      const error = new ShellExecError({
        command: "probe",
        message: "Script runner failed",
        remediation: "Check the script runner.",
        ...(outcome === "typed failure" ? {} : { exitCode: 7 }),
      });
      const run = Effect.sync(() => controller.abort()).pipe(
        Effect.andThen(
          outcome === "mixed cause"
            ? Effect.failCause(Cause.combine(Cause.fail(error), Cause.interrupt()))
            : Effect.fail(error),
        ),
      );
      const exit = await Effect.runPromiseExit(
        runBunShellTooling({ name: "probe", signal: controller.signal }, root).pipe(
          Effect.provide(testEnvironmentResolverLayer),
          Effect.provideService(ShellRunner, {
            run: () => run,
            exec: () => run,
            runScript: () => run,
            interactive: () => Effect.die("unused"),
          }),
        ),
      );
      if (outcome === "observed") {
        expect(Exit.isSuccess(exit) && exit.value?.exitCode).toBe(7);
      } else {
        if (Exit.isSuccess(exit)) throw new TypeError("Expected a script failure");
        expect(Cause.hasInterrupts(exit.cause)).toBe(outcome === "mixed cause");
        expect(Cause.findErrorOption(exit.cause)).toMatchObject({
          _tag: "Some",
          value: { _tag: "ToolingExecError", tool: "app:probe" },
        });
      }
    });
  },
);
