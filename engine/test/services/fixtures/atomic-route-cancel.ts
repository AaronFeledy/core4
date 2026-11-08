import { mock } from "bun:test";
import * as native from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@lando/sdk/services";
import { Effect, Fiber } from "effect";
const original = { ...native };
const root = await original.mkdtemp(join(tmpdir(), "global-sdk-atomic-"));
const file = join(root, "global.yml");
let enter!: () => void;
const entered = new Promise<void>((resolve) => {
  enter = resolve;
});
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let nativeEnd!: () => void;
const completed = new Promise<void>((resolve) => {
  nativeEnd = resolve;
});
const events: string[] = [];
mock.module("node:fs/promises", () => ({
  ...original,
  rename: async (
    source: Parameters<typeof original.rename>[0],
    destination: Parameters<typeof original.rename>[1],
  ) => {
    if (String(destination) === file) {
      events.push("native-rename-entered");
      enter();
      await gate;
    }
    await original.rename(source, destination);
    if (String(destination) === file) {
      events.push("native-rename-finished");
      nativeEnd();
    }
  },
}));
const fsModule = await import("../../../src/services/file-system.ts");
const { withGlobalActivationScope, withGlobalPolicyChange, withGlobalRoutePublication } = await import(
  "../../../src/global-app/activation-scope.ts"
);
const fileSystem = await Effect.runPromise(FileSystem.pipe(Effect.provide(fsModule.layer)));
let receipt: unknown;
try {
  await original.writeFile(file, "initial");
  receipt = await Effect.runPromise(
    withGlobalActivationScope(
      Effect.gen(function* () {
        const writer = yield* Effect.forkChild(
          withGlobalRoutePublication(fileSystem.writeAtomic(file, "old-B-route")),
        );
        yield* Effect.promise(() => entered);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(writer));
        const interruption = yield* Effect.raceFirst(
          Fiber.join(interrupting).pipe(Effect.as("joined")),
          Effect.sleep("25 millis").pipe(Effect.as("pending")),
        );
        const premature = yield* Effect.result(
          withGlobalPolicyChange(
            "disable",
            Effect.sync(() => {
              events.push("premature-policy-admitted");
            }),
          ),
        );
        release();
        yield* Fiber.join(interrupting);
        yield* Effect.promise(() => completed);
        yield* withGlobalPolicyChange("disable", fileSystem.writeAtomic(file, "withdrawn-B-route"));
        return {
          interruption,
          prematurePolicy: premature._tag,
          final: yield* fileSystem.readText(file),
          events,
        };
      }).pipe(Effect.ensuring(Effect.sync(release))),
    ).pipe(Effect.timeout("2 seconds")),
  );
  console.log(JSON.stringify(receipt));
  const result = receipt as { interruption: string; prematurePolicy: string; final: string };
  if (
    result.interruption !== "pending" ||
    result.prematurePolicy !== "Failure" ||
    result.final !== "withdrawn-B-route"
  )
    process.exitCode = 1;
} finally {
  release();
  await original.rm(root, { recursive: true, force: true });
}
