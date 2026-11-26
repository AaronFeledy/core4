#!/usr/bin/env bun
/**
 * The container-helper step of `bun run bootstrap`, run in a child process (see `scripts/bootstrap.ts`):
 * restores `core/container-helper/dist` from the per-user cache keyed by its source digest and prints
 * one JSON report on stdout.
 */
import { join, resolve } from "node:path";

import { containerHelperSourceDigest } from "@lando/container-runtime/container-helper/source";
import {
  defaultContainerHelperCacheRoot,
  publishContainerHelper,
  restoreContainerHelper,
} from "./container-helper-cache.ts";

export interface ContainerHelperRestoreReport {
  readonly status: "current" | "restored" | "missing" | "failed";
  readonly sourceDigest: string;
  readonly detail?: string;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const restore = async (): Promise<ContainerHelperRestoreReport> => {
  const target = {
    dist: join(resolve(import.meta.dirname, ".."), "core/container-helper/dist"),
    sourceDigest: await containerHelperSourceDigest(),
    cacheRoot: defaultContainerHelperCacheRoot(),
  };
  let restored: Awaited<ReturnType<typeof restoreContainerHelper>>;
  try {
    restored = await restoreContainerHelper(target);
  } catch (cause) {
    return {
      status: "failed",
      sourceDigest: target.sourceDigest,
      detail: `restore failed: ${message(cause)}`,
    };
  }
  switch (restored.status) {
    case "current": {
      // Seed the shared cache from a checkout that already built this digest; the checkout is ready either way.
      const detail = await publishContainerHelper(target).then(
        (published) => (published === "published" ? `published to ${target.cacheRoot}` : "cached"),
        (cause: unknown) => `not cached: ${message(cause)}`,
      );
      return { status: "current", sourceDigest: target.sourceDigest, detail };
    }
    case "restored":
      return { status: "restored", sourceDigest: target.sourceDigest, detail: restored.entry };
    case "missing":
      return { status: "missing", sourceDigest: target.sourceDigest, detail: restored.reason };
  }
};

process.stdout.write(`${JSON.stringify(await restore())}\n`);
