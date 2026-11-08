/**
 * Per-app contribution generations over a retained host.
 *
 * One host runtime (minimal tier: config, event bus, redaction, state) serves the session. Each
 * tool call leases the generation of its effective directory's canonical app root: the generated
 * app tier built over the host with that app's plugin selection (retained bundled, system, user,
 * and explicit plugins plus the app's `.lando/plugins`). Generations are cached by app root and
 * selection fingerprint; a warm call re-reads the fingerprint inputs only. Concurrent first calls
 * share one build, failed or interrupted builds are never cached, and a superseded generation's
 * scope closes after its last lease. Each build gets a fresh layer memo map, so one app never
 * receives another app's already-built planner or registries.
 */
import { resolve } from "node:path";

import { Context, Deferred, Effect, Exit, Layer, Ref, Scope, Semaphore, SynchronizedRef } from "effect";

import { findAppRoot } from "@lando/landofile/discovery";
import { OperationDiscovery } from "@lando/landofile/operation-discovery";
import type { PluginLoadError, StateStoreError } from "@lando/sdk/errors";
import { PathsService } from "@lando/sdk/services";
import { bundledPluginModules } from "../composition.ts";
import { canonicalAppRoot } from "../operations/app-mutation-lock.ts";
import { registerPluginReloadDrain } from "../plugins/module-cache.ts";
import { type PluginSelection, resolvePluginSelection } from "../plugins/selection.ts";

import { type GenerationBuilderInput, makeGenerationBuilder } from "./generation-build.ts";
import { type GenerationSlotState, closeIfIdle, initialSlotState, stepSlot } from "./generation-slot.ts";

// A build can import contributions lazily too. Finish it before another build can evict them.
const buildGate = Semaphore.makeUnsafe(1);

export interface AppGenerationRecord {
  readonly key: string;
  readonly context: Context.Context<unknown>;
}

export interface AppGenerations<Record, Failure> {
  readonly acquire: (
    cwd: string,
  ) => Effect.Effect<Record, Failure | PluginLoadError | StateStoreError, Scope.Scope | OperationDiscovery>;
}

interface Slot<Record, Failure> {
  readonly built: Deferred.Deferred<Record, Failure | PluginLoadError>;
  readonly closed: Deferred.Deferred<void>;
  readonly scope: Scope.Closeable;
  readonly state: Ref.Ref<GenerationSlotState<Record, PluginSelection>>;
}

export const makeAppGenerations = Effect.fnUntraced(function* <
  Host,
  Services,
  Record extends AppGenerationRecord,
  Failure,
>(
  input: GenerationBuilderInput<Host, Services, Record, Failure> & {
    readonly refresh: (record: Record) => Effect.Effect<Record, Failure>;
  },
): Effect.fn.Return<AppGenerations<Record, Failure>, never, Scope.Scope> {
  const sessionScope = yield* Effect.scope;
  const host = Context.makeUnsafe<Host | PathsService>(
    Context.omit(Layer.CurrentMemoMap)(input.host).mapUnsafe,
  );
  const paths = Context.get(host, PathsService);
  // The current slot per app root; the lock serializes lookup, supersession, and slot creation.
  const slots = yield* SynchronizedRef.make<ReadonlyMap<string, Slot<Record, Failure>>>(new Map());
  const open = new Set<Slot<Record, Failure>>();

  const closeSlotIfIdle = (slot: Slot<Record, Failure>) =>
    Effect.flatMap(closeIfIdle(slot.state), (closed) =>
      closed ? Scope.close(slot.scope, Exit.void) : Effect.void,
    );

  const release = (slot: Slot<Record, Failure>) =>
    stepSlot(slot.state, "release", (current) => ({ ...current, leases: current.leases - 1 })).pipe(
      Effect.andThen(closeSlotIfIdle(slot)),
    );

  /** Settle a build: a success becomes the slot's record; a failure is never cached. */
  const settle = (
    key: string,
    slot: Slot<Record, Failure>,
    exit: Exit.Exit<
      { readonly record: Record; readonly selection: PluginSelection },
      Failure | PluginLoadError
    >,
  ) =>
    Exit.isSuccess(exit)
      ? Effect.gen(function* () {
          yield* stepSlot(
            slot.state,
            (state) => (state.phase === "superseded" ? "finish" : "ready"),
            (current) => ({
              ...current,
              record: exit.value.record,
              selection: exit.value.selection,
            }),
          );
          yield* Deferred.done(slot.built, Exit.succeed(exit.value.record));
        })
      : SynchronizedRef.update(slots, (current) => {
          if (current.get(key) !== slot) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        }).pipe(
          Effect.andThen(stepSlot(slot.state, "fail")),
          Effect.andThen(Scope.close(slot.scope, exit)),
          Effect.andThen(Deferred.done(slot.built, Exit.failCause(exit.cause))),
        );

  const buildStable = makeGenerationBuilder({ ...input, host });

  /** Retry owners that failed to project; a recovered record replaces the slot's current one. */
  const refreshFailedCommands = Effect.fnUntraced(function* (slot: Slot<Record, Failure>, record: Record) {
    const refreshed = yield* input.refresh(record);
    const stored = yield* stepSlot(slot.state, "refresh", (state) =>
      // A concurrent retry that already replaced this record wins.
      state.record === record ? { ...state, record: refreshed } : state,
    );
    // A superseded slot keeps its old record; this call still uses what it recovered.
    return stored.record === undefined || stored.record === record ? refreshed : stored.record;
  });

  /** Lease the current slot for `key` and `fingerprint`, starting its build when none matches. */
  const leaseSlot = Effect.fnUntraced(function* (key: string, selection: PluginSelection) {
    return yield* SynchronizedRef.modifyEffect(slots, (current) =>
      Effect.gen(function* () {
        const existing = current.get(key);
        const state = existing === undefined ? undefined : yield* Ref.get(existing.state);
        const phase = state?.phase;
        if (
          existing !== undefined &&
          state?.selection.fingerprint === selection.fingerprint &&
          (phase === "building" || phase === "ready")
        ) {
          yield* stepSlot(existing.state, "lease", (state) => ({ ...state, leases: state.leases + 1 }));
          return [existing, current] as const;
        }
        const slot: Slot<Record, Failure> = {
          built: yield* Deferred.make<Record, Failure | PluginLoadError>(),
          closed: yield* Deferred.make<void>(),
          scope: yield* Scope.fork(sessionScope),
          state: yield* Ref.make(initialSlotState<Record, PluginSelection>(selection)),
        };
        open.add(slot);
        yield* Scope.addFinalizer(
          slot.scope,
          Effect.gen(function* () {
            open.delete(slot);
            yield* Deferred.succeed(slot.closed, undefined);
          }),
        );
        if (existing !== undefined) {
          if (phase === "building" || phase === "ready") yield* stepSlot(existing.state, "supersede");
          yield* closeSlotIfIdle(existing);
        }
        yield* buildStable(key, selection, slot.scope).pipe(
          Effect.exit,
          Effect.flatMap((exit) => settle(key, slot, exit)),
          buildGate.withPermits(1),
          Effect.forkIn(sessionScope),
        );
        return [slot, new Map(current).set(key, slot)] as const;
      }),
    );
  }, Effect.uninterruptible);

  const unregister = registerPluginReloadDrain((previous) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const affected = yield* SynchronizedRef.modifyEffect(slots, (current) =>
          Effect.gen(function* () {
            const matches: Slot<Record, Failure>[] = [];
            for (const slot of open) {
              const state = yield* Ref.get(slot.state);
              if (
                !state.selection.implementations.some(
                  (implementation) =>
                    implementation.realpath === previous.realpath &&
                    implementation.identity === previous.identity,
                )
              )
                continue;
              // Other building slots are queued before import; a retry has closed its old attempt.
              if (state.record === undefined) continue;
              if (state.phase !== "ready" && state.phase !== "superseded") continue;
              if (state.phase === "ready") yield* stepSlot(slot.state, "supersede");
              matches.push(slot);
            }
            return [matches, current] as const;
          }),
        );
        for (const slot of affected) {
          yield* closeSlotIfIdle(slot);
          yield* Deferred.await(slot.closed);
        }
      }),
    ),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unregister));

  const acquire = Effect.fn("AppGenerations.acquire")(function* (cwd: string) {
    // The caller's operation memo: this call's acquisition and execution share one discovery.
    yield* OperationDiscovery;
    const root = yield* findAppRoot(cwd).pipe(Effect.provide(host));
    const appRoot = root === undefined ? undefined : yield* canonicalAppRoot(root);
    const key = appRoot ?? resolve(cwd);
    const selection = yield* resolvePluginSelection({
      policy: input.policy,
      roots: paths,
      modules: bundledPluginModules(),
      appRoot,
    }).pipe(Effect.provide(host));
    const slot = yield* Effect.acquireRelease(leaseSlot(key, selection), release);
    const built = yield* Deferred.await(slot.built);
    return yield* refreshFailedCommands(slot, (yield* Ref.get(slot.state)).record ?? built);
  });

  return { acquire };
});
