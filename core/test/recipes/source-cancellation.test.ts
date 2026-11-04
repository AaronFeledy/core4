import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { Effect } from "effect";
import { resolveGitRecipeSource } from "../../src/recipes/git-source";
import { resolveTarballRecipeSource } from "../../src/recipes/tarball-source";
import {
  type ArchiveTransport,
  type GitTransport,
  withRecipeSources,
} from "../_support/recipe-source-session";

const abortable = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

const bounded = <A>(promise: Promise<A>) =>
  Effect.runPromise(Effect.promise(() => promise).pipe(Effect.timeout("2 seconds")));

test.each(["git", "tarball"] as const)(
  "aborting the caller's signal stops an in-flight %s recipe acquisition and cleans its staging",
  async (kind) => {
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const git: GitTransport = {
      fetch: ({ signal }) => {
        entered.resolve(signal);
        return abortable(signal);
      },
    };
    const archive: ArchiveTransport = {
      fetch: (_url, options) => {
        entered.resolve(options?.signal);
        return abortable(options?.signal);
      },
    };
    await withRecipeSources({ git, archive }, async ({ session, root }) => {
      const controller = new AbortController();
      const resolving =
        kind === "git"
          ? resolveGitRecipeSource({
              url: "https://example.test/hang.git",
              sources: session,
              signal: controller.signal,
            })
          : resolveTarballRecipeSource({
              url: "https://example.test/hang.tgz",
              sources: session,
              signal: controller.signal,
            });
      const settled = resolving.then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      const transportSignal = await bounded(entered.promise);
      expect(transportSignal?.aborted).toBe(false);
      controller.abort();
      expect(await bounded(settled)).toBe("rejected");
      expect(transportSignal?.aborted).toBe(true);
      expect((await readdir(root)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
    });
  },
);
