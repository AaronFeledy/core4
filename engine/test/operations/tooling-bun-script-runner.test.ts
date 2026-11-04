import { expect, test } from "bun:test";
import { Effect } from "effect";
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
