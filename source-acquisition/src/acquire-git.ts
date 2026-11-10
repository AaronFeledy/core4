import { rm } from "node:fs/promises";
import { mapFailures } from "@lando/sdk/command-result";
import { Effect } from "effect";
import { SourceAcquisitionError, acquisitionError, displaySource } from "./errors.ts";
import { isLiteralGitRef } from "./locator.ts";
import { sourceRecords } from "./records.ts";
import { type Storage, io } from "./storage.ts";
import { acquireTransport } from "./transport.ts";
import { containedPath } from "./tree.ts";
import type {
  GitAcquisitionOptions,
  GitPin,
  MaterializeOptions,
  SourceSnapshot,
  SourceStoreOptions,
} from "./types.ts";

export const gitAcquisition = (options: SourceStoreOptions, storage: Storage) => {
  const openGit = (commit: string) => storage.open({ kind: "git", commit }, { kind: "git", url: "", commit });
  const acquireGit = Effect.fn("SourceSession.acquireGit")(function* (
    locator: { readonly url: string; readonly ref?: string },
    acquisition: GitAcquisitionOptions = {},
  ): Effect.fn.Return<SourceSnapshot<GitPin>, SourceAcquisitionError> {
    if (locator.ref !== undefined && !isLiteralGitRef(locator.ref))
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: `Invalid git ref: ${locator.ref}`,
          source: displaySource(locator.url),
          kind: "invalid-locator",
          remediation: "Choose a literal tag, branch, or full commit SHA.",
        }),
      );
    const pinned = /^[a-f\d]{40}$/iu.test(locator.ref ?? "") ? locator.ref?.toLowerCase() : undefined;
    const verify = acquisition.repair === true;
    if (pinned !== undefined) {
      const snapshot = yield* storage.open(
        { kind: "git", commit: pinned },
        { kind: "git", url: locator.url, commit: pinned },
        { verify },
      );
      if (snapshot !== undefined) return snapshot;
    }
    const transport = options.transports.git;
    if (transport === undefined)
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: "Git source transport is unavailable.",
          source: displaySource(locator.url),
          kind: "fetch-failed",
          remediation: "Provide the host git transport and retry.",
        }),
      );
    const refs = yield* sourceRecords(options.stateStore).ref(locator.url, locator.ref ?? "HEAD");
    const resolve = transport.resolve;
    if (pinned === undefined && resolve !== undefined) {
      const cachedHit = yield* Effect.result(
        Effect.gen(function* () {
          const raw = yield* acquireTransport(locator.url, (signal) =>
            resolve({
              url: locator.url,
              ...(locator.ref === undefined ? {} : { ref: locator.ref }),
              signal,
            }),
          );
          if (raw === undefined) return undefined;
          const commit = raw.toLowerCase();
          if (!/^[a-f\d]{40}$/u.test(commit)) return undefined;
          const snapshot = yield* storage.open(
            { kind: "git", commit },
            { kind: "git", url: locator.url, commit },
            { verify },
          );
          if (snapshot === undefined) return undefined;
          yield* storage.sessionLocked(refs.set({ commit }));
          return snapshot;
        }),
      );
      if (cachedHit._tag === "Failure") {
        if (cachedHit.failure.kind !== "fetch-failed") return yield* Effect.fail(cachedHit.failure);
      } else if (cachedHit.success !== undefined) {
        return cachedHit.success;
      }
    }
    const fetched = storage.stage((stage) =>
      Effect.gen(function* () {
        const tree = containedPath(stage, "tree");
        const result = yield* acquireTransport(locator.url, (signal) =>
          transport.fetch({ ...locator, dest: tree, signal }),
        );
        const commit = result.commit.toLowerCase();
        if (!/^[a-f\d]{40}$/u.test(commit) || (pinned !== undefined && commit !== pinned))
          return yield* Effect.fail(
            new SourceAcquisitionError({
              message: `Git acquisition returned commit ${commit}, not a full SHA${pinned === undefined ? "" : ` matching ${pinned}`}.`,
              source: displaySource(locator.url),
              kind: "fetch-failed",
              remediation: "Fetch the exact requested full commit SHA.",
              ...(pinned === undefined ? {} : { expected: pinned, actual: displaySource(commit) }),
            }),
          );
        yield* io(locator.url, () => rm(containedPath(tree, ".git"), { recursive: true, force: true }));
        const snapshot = yield* storage.publish({
          key: { kind: "git", commit },
          pin: { kind: "git", url: locator.url, commit },
          stage,
          repair: verify,
          source: locator.url,
        });
        yield* storage.sessionLocked(refs.set({ commit }));
        return snapshot;
      }),
    );
    return yield* fetched.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (error.kind !== "fetch-failed" || acquisition.onStaleFallback === undefined)
            return yield* Effect.fail(error);
          const previous = yield* refs.get.pipe(
            mapFailures((cause) => acquisitionError("cache", "git ref", cause)),
          );
          if (previous === null) return yield* Effect.fail(error);
          const snapshot = yield* storage.open(
            { kind: "git", commit: previous.commit },
            { kind: "git", url: locator.url, commit: previous.commit },
          );
          if (snapshot === undefined) return yield* Effect.fail(error);
          yield* Effect.tryPromise({
            try: async () => acquisition.onStaleFallback?.(previous.commit),
            catch: (cause) => acquisitionError("fetch-failed", locator.url, cause),
          });
          return snapshot;
        }),
      ),
    );
  });
  const materializeGit = Effect.fn("SourceSession.materializeGit")(function* (
    pin: { readonly url: string; readonly commit: string },
    acquisition: MaterializeOptions = {},
  ) {
    const cached = yield* storage.open(
      { kind: "git", commit: pin.commit },
      { kind: "git", ...pin },
      { verify: acquisition.repair === true },
    );
    if (cached !== undefined) return cached;
    if (acquisition.network === false)
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: "Pinned git source is not cached.",
          source: displaySource(pin.url),
          kind: "offline-miss",
          remediation: "Acquire this exact commit with network access first.",
        }),
      );
    return yield* acquireGit({ url: pin.url, ref: pin.commit }, acquisition);
  });
  return { openGit, acquireGit, materializeGit };
};
