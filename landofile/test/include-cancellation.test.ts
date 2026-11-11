import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitTransport } from "@lando/source-acquisition";
import { Effect, Fiber } from "effect";
import { resolveAuthoredIncludes, updateAuthoredIncludes } from "./include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const abortable = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal === undefined) return;
    const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

test.each(["resolve", "update"] as const)(
  "interrupting an include %s walk aborts the in-flight git fetch and releases its staging and lease",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "lando-include-cancel-"));
    const cacheRoot = join(root, "cache");
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const git: GitTransport = {
      fetch: ({ signal }) => {
        entered.resolve(signal);
        return abortable(signal);
      },
    };
    try {
      const options = {
        appRoot: root,
        cacheRoot,
        ports: makeTestLandofilePorts(cacheRoot, cacheRoot, { git }),
        stateStore: makeTestLandofileStateStore(cacheRoot),
        landofile: { name: "cancel", includes: [{ source: "github:acme/hang", path: "fragment.yml" }] },
      };
      const walk =
        mode === "resolve"
          ? resolveAuthoredIncludes(options).pipe(Effect.asVoid)
          : updateAuthoredIncludes(options).pipe(Effect.asVoid);
      const fiber = Effect.runFork(walk);
      const signal = await Effect.runPromise(
        Effect.promise(() => entered.promise).pipe(Effect.timeout("2 seconds")),
      );
      expect(signal?.aborted).toBe(false);
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds")));
      expect(signal?.aborted).toBe(true);
      const store = join(cacheRoot, "sources");
      expect((await readdir(store)).filter((name) => name.startsWith(".staging-"))).toEqual([]);
      expect(await readdir(join(store, ".leases"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
