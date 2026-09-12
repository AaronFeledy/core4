import { readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { UpdateResultSchema, makeUpdateHandoff } from "@lando/engine/operations/update";
import { resolveLandoRoots } from "@lando/paths";
import { StateStore } from "@lando/sdk/services";
import { StateStoreLive } from "@lando/state-store/service";
import { Effect, Layer } from "effect";
import { renderUpdateResult } from "./command-specs/meta/update.ts";
import { extractFormatFlags, resolveResultFormat } from "./format-flags.ts";
import { runWithRendererHandling } from "./renderer-boundary.ts";
import { resolveCliRendererMode } from "./renderer-mode-resolution.ts";

export const surfaceDeferredUpdateReceipts = async (argv: ReadonlyArray<string>): Promise<boolean> => {
  const flags = argv.slice(0, argv.indexOf("--") === -1 ? undefined : argv.indexOf("--"));
  if (flags.some((arg) => arg === "--dry-run" || arg.startsWith("--dry-run="))) return false;
  const formatFlags = extractFormatFlags(argv);
  if (formatFlags.jsonList) return false;
  const renderer = await resolveCliRendererMode({ argv, env: process.env });
  const { format } = resolveResultFormat({ argv, rendererMode: renderer.mode });
  const receipt = await Effect.runPromise(
    Effect.gen(function* () {
      const handoff = makeUpdateHandoff(yield* StateStore);
      const names = yield* Effect.tryPromise(() =>
        readdir(join(resolveLandoRoots().userCacheRoot, "update-handoff")).catch((cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
          throw cause;
        }),
      );
      for (const name of names.filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name)).sort()) {
        const result = yield* handoff.consumeDeferred(name.slice(0, -5));
        if (result !== undefined) return result;
      }
      return undefined;
    }).pipe(Effect.provide(StateStoreLive)),
  );
  await rmdir(join(resolveLandoRoots().userCacheRoot, "update-handoff")).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && (cause.code === "ENOTEMPTY" || cause.code === "ENOENT"))
      return;
    throw cause;
  });
  if (receipt === undefined) return false;
  await runWithRendererHandling(Effect.succeed(receipt), {
    runtime: Layer.empty,
    command: "meta:update",
    rendererMode: renderer.mode,
    resultFormat: format === "ndjson" ? "json" : format,
    resultSchema: UpdateResultSchema,
    deprecationWarnings: false,
    successExitCode: (result) =>
      result.hasFailures === true || result.coreFailure !== undefined || result.coreBlocked === true
        ? 1
        : undefined,
    render: (result) =>
      format === "yaml"
        ? Bun.YAML.stringify(result)
        : `Previous Windows update result:\n${renderUpdateResult(result)}`,
    formatError: String,
  });
  return true;
};
