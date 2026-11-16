import { expect, test } from "bun:test";
import { BuildOrchestrator, StateStore } from "@lando/sdk/services";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { BuildOwner, openAppBuildResults } from "../../src/services/build-results.ts";
import { makeLayer, planWith, providerId, withTempRoots } from "./build-app-runner-test-support.ts";
import { oneStep, retainedProvider } from "./build-app-settlement-support.ts";

test("switching app commands old -> new -> old reruns in the same native container", async () => {
  await withTempRoots(async () => {
    const calls: string[] = [];
    const provider = {
      ...retainedProvider,
      execStream: (_target: unknown, command: { readonly command: readonly string[] }) => {
        calls.push(command.command.join(" "));
        return Stream.make({ exitCode: 0 });
      },
    };
    const changed = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["new"] } }],
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const build = yield* BuildOrchestrator;
        yield* build.buildApp(oneStep);
        yield* build.buildApp(changed);
        yield* build.buildApp(oneStep);
        yield* build.buildApp(oneStep);
      }).pipe(Effect.provide(makeLayer(provider))),
    );

    expect(calls).toEqual(["install", "new", "install"]);
  });
});

for (const observation of [undefined, "different-container"] as const) {
  test(`redispatch invalidates a known success before execution when the new identity is ${observation ?? "unknown"}`, async () => {
    await withTempRoots(async () => {
      const executing = Deferred.makeUnsafe<void>();
      let redispatch = false;
      let commands = 0;
      const provider = {
        ...retainedProvider,
        inspect: (target: Parameters<typeof retainedProvider.inspect>[0]) =>
          redispatch
            ? Effect.succeed({
                ...target,
                providerId,
                publications: { status: "unknown" as const },
                status: "running" as const,
                ...(observation === undefined ? {} : { containerId: observation }),
              })
            : retainedProvider.inspect(target),
        execStream: () => {
          commands += 1;
          return redispatch
            ? Stream.fromEffect(Deferred.succeed(executing, undefined).pipe(Effect.andThen(Effect.never)))
            : Stream.make({ exitCode: 0 });
        },
      };
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const build = yield* BuildOrchestrator;
            yield* build.buildApp(oneStep);
            redispatch = true;
            const bucket = yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(oneStep));
            const fiber = yield* Effect.forkChild(build.buildApp(oneStep));
            yield* Deferred.await(executing);
            const during = yield* bucket.get;
            yield* Fiber.interrupt(fiber);
            const interrupted = yield* bucket.get;
            redispatch = false;
            yield* build.buildApp(oneStep);
            return { during, interrupted };
          }),
        ).pipe(Effect.provide(makeLayer(provider))),
      );
      expect(result.during).toMatchObject([
        { outcome: "complete", containerId: "retained-1", invalidated: true },
      ]);
      expect(result.interrupted).toMatchObject([{ outcome: "fail" }]);
      expect(commands).toBe(3);
    });
  });
}
