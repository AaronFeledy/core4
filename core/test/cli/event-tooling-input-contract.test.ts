import { expect, spyOn, test } from "bun:test";
import * as EventTooling from "@lando/engine/operations/event-tooling-command";
import { attachEffectiveTooling } from "@lando/engine/planner/effective-tooling";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { Context, DateTime, Effect } from "effect";
import { resolveEventCommandTarget } from "../../src/cli/event-command-target.ts";

test("preserves named maps and the retained revision through the event adapter", async () => {
  // Given
  const plan = attachEffectiveTooling(
    {
      id: AppId.make("event-input"),
      name: "event-input",
      slug: "event-input",
      root: AbsolutePath.make(process.cwd()),
      provider: ProviderId.make("test"),
      services: {},
      routes: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata: {
        resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        source: "/app/.lando.yml",
        runtime: 4 as const,
      },
    },
    {
      inspect: {
        cmd: ["inspect"],
        flags: { mode: { alias: "m" } },
        args: { second: { order: 2 }, first: { order: 1 } },
      },
    },
  );
  const requests: EventTooling.EventToolingInvocation[] = [];
  const runner = spyOn(EventTooling, "runEventToolingCommand").mockImplementation((request) => {
    requests.push(request);
    return Effect.succeed({ tool: "inspect", service: "", exitCode: 0, stdout: "", stderr: "" });
  });
  try {
    const target = await Effect.runPromise(
      resolveEventCommandTarget("app:inspect", Context.empty(), [], plan),
    );
    if (target.kind !== "tooling") throw new Error("Missing tooling target");
    // When
    await Effect.runPromise(
      target.spec
        .run({ flags: { mode: "dev" }, args: { first: "one", second: "two" }, argv: [], parsedArgv: [] })
        .pipe(Effect.provide(Context.make(Context.Service<unknown>("event-input-runtime"), {}))),
    );
    // Then
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      input: {
        _tag: "NamedMaps",
        flags: { mode: "dev" },
        args: { first: "one", second: "two" },
        passthroughArgv: [],
      },
      expectedInputRevision: target.toolingInput.revision,
    });
  } finally {
    runner.mockRestore();
  }
});
