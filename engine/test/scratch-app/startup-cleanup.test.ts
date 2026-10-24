import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderUnavailableError, ScratchAppError, ServiceNotReadyError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { type RuntimeProviderShape, ScratchAppService, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { ScratchRegistry } from "../../src/scratch-app/registry.ts";
import { failureOf } from "../subsystems/healthcheck/support.ts";
import { withStartupFixture } from "./startup-fixture.ts";

const running: RuntimeProviderShape["inspect"] = (target) =>
  Effect.succeed<ServiceRuntimeInfo>({
    app: target.app,
    service: target.service,
    providerId: ProviderId.make("lando"),
    status: "running",
    state: "running",
    publications: { status: "unknown" },
    lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
    containerId: "scratch-web",
  });
const acquire = (options: { readonly keepOnFailure?: boolean; readonly detached?: boolean } = {}) =>
  Effect.flatMap(ScratchAppService, (scratch) =>
    scratch.acquire({
      source: { kind: "fork" },
      isolate: "none",
      detached: options.detached ?? false,
      ...(options.keepOnFailure === undefined ? {} : { keepOnFailure: options.keepOnFailure }),
    }),
  );

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "scratch readiness failure cleans only its instance unless retained (keep=%s detached=%s)",
  async (keepOnFailure, detached) => {
    // Given an applied scratch fork that uses the source root and fails readiness.
    await withStartupFixture(
      {
        inspect: (target) =>
          Effect.succeed<ServiceRuntimeInfo>({
            app: target.app,
            service: target.service,
            providerId: ProviderId.make("lando"),
            status: "stopped",
            state: "stopped",
            publications: { status: "unknown" },
            exitCode: 17,
          }),
      },
      async (f) => {
        // When ordinary acquisition fails after apply.
        const exit = await Effect.runPromiseExit(
          acquire({ keepOnFailure, detached }).pipe(Effect.scoped, Effect.provide(f.layer)),
        );
        // Then cleanup follows retention policy and leaves the source untouched.
        const failure = failureOf(exit);
        expect(failure).toMatchObject({
          _tag: "ScratchAppError",
          cause: { _tag: "ServiceNotReadyError" },
        });
        if (!(failure instanceof ScratchAppError) || !(failure.cause instanceof ServiceNotReadyError))
          throw new TypeError("Expected scratch readiness failure");
        expect(failure.message).toContain(failure.cause.message);
        if (keepOnFailure) expect(failure.remediation).toBe(failure.cause.remediation);
        else expect(failure.remediation).toContain("--keep-on-failure");
        expect(f.applied).toHaveLength(1);
        expect(f.destroyed).toHaveLength(keepOnFailure ? 0 : 1);
        const id = f.applied[0]?.id;
        if (id === undefined) throw new TypeError("Expected applied scratch plan");
        expect(existsSync(join(f.root, "scratch", id))).toBe(keepOnFailure);
        expect(f.entries.size).toBe(keepOnFailure ? 1 : 0);
        expect(await readFile(join(f.sourceRoot, "keep.txt"), "utf8")).toBe("source survives");
        expect(f.events.filter((event) => event._tag === "post-scratch-destroy")).toHaveLength(
          keepOnFailure ? 0 : 1,
        );
      },
    );
  },
);

test.each([false, true])(
  "scratch interruption after apply obeys retention policy (keep=%s)",
  async (keepOnFailure) => {
    // Given readiness held at a deterministic gate after provider apply.
    const entered = Deferred.makeUnsafe<void>();
    await withStartupFixture(
      {
        inspect: running,
        exec: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      },
      async (f) => {
        // When the acquiring fiber is interrupted while probing.
        const fiber = Effect.runFork(acquire({ keepOnFailure }).pipe(Effect.scoped, Effect.provide(f.layer)));
        await Effect.runPromise(Deferred.await(entered));
        await Effect.runPromise(Fiber.interrupt(fiber));
        const exit = await Effect.runPromise(Fiber.await(fiber));
        // Then cancellation stays cancellation, with exactly one reap unless retained.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(f.destroyed).toHaveLength(keepOnFailure ? 0 : 1);
        expect(f.entries.size).toBe(keepOnFailure ? 1 : 0);
        expect(await readFile(join(f.sourceRoot, "keep.txt"), "utf8")).toBe("source survives");
      },
    );
  },
);

test.each([false, true])(
  "successful scratch scope preserves detached ownership (detached=%s)",
  async (detached) => {
    // Given a ready scratch service and a separately controlled acquisition scope.
    await withStartupFixture(
      { inspect: running, exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }) },
      async (f) => {
        const scope = await Effect.runPromise(Scope.make());
        try {
          // When successful acquisition transfers ownership to its scope or detached registry.
          const handle = await Effect.runPromise(
            acquire({ detached }).pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(f.layer)),
          );
          expect(f.destroyed).toEqual([]);
          await Effect.runPromise(Scope.close(scope, Exit.void));
          // Then scoped instances reap once, while detached instances remain registered.
          expect(f.destroyed).toEqual(detached ? [] : [handle.id]);
          expect(f.entries.has(handle.id)).toBe(detached);
          expect(existsSync(join(f.root, "scratch", handle.id))).toBe(detached);
          expect(await readFile(join(f.sourceRoot, "keep.txt"), "utf8")).toBe("source survives");
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
      },
    );
  },
);

test("scratch apply failure uses the same acquisition cleanup boundary", async () => {
  // Given provider mutation followed by an apply error.
  await withStartupFixture(
    {
      apply: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "apply",
            message: "injected apply failure",
          }),
        ),
    },
    async (f) => {
      // When apply fails before completion begins.
      const exit = await Effect.runPromiseExit(acquire().pipe(Effect.scoped, Effect.provide(f.layer)));
      // Then failure retains its cause and reaps the task-owned instance once.
      expect(failureOf(exit)).toMatchObject({
        _tag: "ScratchAppError",
        cause: { _tag: "ProviderUnavailableError" },
      });
      expect(f.destroyed).toHaveLength(1);
      expect(f.entries.size).toBe(0);
      expect(await readFile(join(f.sourceRoot, "keep.txt"), "utf8")).toBe("source survives");
    },
  );
});

test("scratch interruption during apply reaps the acquiring instance", async () => {
  // Given an apply held after acquisition has taken ownership of the instance.
  const entered = Deferred.makeUnsafe<void>();
  await withStartupFixture(
    { apply: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) },
    async (f) => {
      // When acquisition is interrupted before completion can run.
      const fiber = Effect.runFork(acquire().pipe(Effect.scoped, Effect.provide(f.layer)));
      await Effect.runPromise(Deferred.await(entered));
      await Effect.runPromise(Fiber.interrupt(fiber));
      const exit = await Effect.runPromise(Fiber.await(fiber));
      // Then the failure boundary reaps once and preserves the interruption and source.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(f.destroyed).toHaveLength(1);
      expect(f.entries.size).toBe(0);
      expect(await readFile(join(f.sourceRoot, "keep.txt"), "utf8")).toBe("source survives");
    },
  );
});

test("scratch converted to detached during its scope stays registered", async () => {
  // Given a successful foreground acquisition that is retained before scope close.
  await withStartupFixture(
    { inspect: running, exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }) },
    async (f) => {
      // When registry ownership becomes detached before the foreground scope closes.
      const handle = await Effect.runPromise(
        Effect.gen(function* () {
          const handle = yield* acquire();
          const registry = yield* ScratchRegistry;
          const entry = yield* registry.get(handle.id);
          if (entry === undefined)
            return yield* Effect.die("Scratch acquisition did not register its instance");
          yield* registry.upsert({ ...entry, detached: true });
          return handle;
        }).pipe(Effect.scoped, Effect.provide(f.layer)),
      );
      // Then the scope does not reclaim the detached instance or remove the source.
      expect(f.destroyed).toEqual([]);
      expect(f.entries.get(handle.id)?.detached).toBe(true);
      expect(existsSync(join(f.root, "scratch", handle.id))).toBe(true);
      expect(await readFile(join(f.sourceRoot, "keep.txt"), "utf8")).toBe("source survives");
    },
  );
});

test.each([false, true])(
  "scratch registration interruption stays acquisition-owned (keep=%s)",
  async (keepOnFailure) => {
    // Given completed readiness and a pending final registry update.
    const entered = Deferred.makeUnsafe<void>();
    await withStartupFixture(
      { inspect: running, exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }) },
      async (f) => {
        // When cancellation arrives before acquisition has returned its handle.
        const fiber = Effect.runFork(acquire({ keepOnFailure }).pipe(Effect.scoped, Effect.provide(f.layer)));
        await Effect.runPromise(Deferred.await(entered));
        await Effect.runPromise(Fiber.interrupt(fiber));
        const exit = await Effect.runPromise(Fiber.await(fiber));
        // Then keep-on-failure wins rather than an already-registered success finalizer.
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(f.destroyed).toHaveLength(keepOnFailure ? 0 : 1);
        expect(f.entries.size).toBe(keepOnFailure ? 1 : 0);
        expect(await readFile(join(f.sourceRoot, "keep.txt"), "utf8")).toBe("source survives");
      },
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    );
  },
);
