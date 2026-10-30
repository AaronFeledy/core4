import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseScriptFile } from "@lando/landofile/bun-sh-discovery";
import { normalizeToolingTask } from "@lando/landofile/tooling-normalize";
import { EnvironmentValueResolver, EventService, type LandoEvent } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Result } from "effect";
import { runBunShellScript, runBunShellTooling } from "../../src/operations/tooling-bun-script.ts";
import { recordingScriptEvents, withBunScript } from "./tooling-bun-script-support.ts";

test.each(["direct", "discovery"])(
  "%s refuses stale declarations before resolver, progress, or body",
  async (entry) => {
    // Given
    await withBunScript(
      "# ---\n# args:\n#   second:\n#   first:\n# ---\necho executed > marker\n",
      async (root) => {
        const expectedInput = Result.getOrThrow(
          normalizeToolingTask("probe", { args: { first: {}, second: {} } }),
        );
        const script = await Effect.runPromise(
          parseScriptFile(join(root, ".lando/scripts/probe.bun.sh"), "probe.bun.sh"),
        );
        let sessions = 0;
        const events: LandoEvent[] = [];
        const options = {
          input: { _tag: "RawArgv" as const, argv: ["one", "two"] },
          expectedInputRevision: expectedInput.input.revision,
        };
        // When
        const result = await Effect.runPromise(
          Effect.result(
            entry === "direct"
              ? runBunShellScript(script, root, options)
              : runBunShellTooling({ name: "probe", ...options }, root),
          ).pipe(
            Effect.provide(PrivateFileAccessService.layer),
            Effect.provideService(
              EnvironmentValueResolver,
              EnvironmentValueResolver.of({
                openSession: () =>
                  Effect.sync(() => {
                    sessions++;
                    return { resolveEnvironment: () => Effect.succeed({}) };
                  }),
              }),
            ),
            Effect.provideService(EventService, recordingScriptEvents(events)),
          ),
        );
        // Then
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ToolingInputError" } });
        expect({ sessions, events, bodyRan: existsSync(join(root, "marker")) }).toEqual({
          sessions: 0,
          events: [],
          bodyRan: false,
        });
      },
    );
  },
);
