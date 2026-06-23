import { Effect, Layer, Queue, Stream } from "effect";

import { EventService } from "@lando/core/services";
import { createRedactor } from "@lando/sdk/secrets";
import { type BunSelfSpawner, bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { RedactionService } from "../../src/redaction/service.ts";

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
});

describe("bunSelfRun redaction", () => {
  test("redacts free-text pre/post bun-self-exec event fields without changing event shape", async () => {
    const events: Array<Record<string, unknown>> = [];
    const eventLayer = Layer.succeed(EventService, {
      publish: (event) => Effect.sync(() => events.push({ ...event })),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<never>(),
      waitFor: () => Effect.never,
    } satisfies EventService.Service);
    const spawner: BunSelfSpawner = {
      spawn: async () => ({ exitCode: 0 }),
    };

    await Effect.runPromise(
      bunSelfRun({
        argv: ["install", "--registry=https://topsecret.example"],
        cwd: "/tmp/topsecret-project",
        env: { BUN_AUTH_TOKEN: "topsecret" },
        spawner,
        execPath: "/bin/bun",
        callerSubsystem: "plugin-topsecret",
        verb: "install-topsecret",
      }).pipe(Effect.provide(Layer.mergeAll(eventLayer, redactionLayer))),
    );

    expect(events).toHaveLength(2);
    expect(events.map((event) => event._tag)).toEqual(["pre-bun-self-exec", "post-bun-self-exec"]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        event._tag === "pre-bun-self-exec"
          ? ["_tag", "argv", "callerSubsystem", "cwd", "mode", "timestamp", "verb"]
          : ["_tag", "argv", "callerSubsystem", "cwd", "exitCode", "mode", "timestamp", "verb"],
      );
      expect(JSON.stringify(event)).not.toContain("topsecret");
      expect(JSON.stringify(event)).toContain("[redacted]");
      expect(event.mode).toBe("embedded");
    }
  });
});
