import { Predicate, Result, Schema } from "effect";

import { PluginDescriptorMismatchError } from "@lando/sdk/errors";
import type { PluginDoctorCheckContribution } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";

import type { LoadedPluginContribution } from "./contribution-graph.ts";

/** Read only doctor contributions; manifest-only capabilities need no executable descriptor here. */
export const pluginDoctorCheckIndex = (
  plugins: ReadonlyArray<LoadedPluginContribution>,
): Result.Result<ReadonlyMap<string, PluginDoctorCheckContribution>, PluginDescriptorMismatchError> => {
  const checks = new Map<string, PluginDoctorCheckContribution>();
  for (const plugin of plugins) {
    const pluginName = String(plugin.manifest.name);
    const mismatch = (message: string) =>
      new PluginDescriptorMismatchError({
        pluginName,
        kind: "doctorChecks",
        declared: [],
        provided: [],
        message: `Plugin ${pluginName}: ${message}`,
        remediation: "Repair the owning plugin's doctorChecks descriptor or remove and reinstall the plugin.",
      });
    try {
      let collection: ReadonlyArray<unknown> | undefined;
      // A present malformed collection must fail, rather than fall through to another export.
      const carriers = [plugin.entry, plugin.module];
      for (let index = 0; index < 3; index++) {
        const carrier =
          index === 2
            ? plugin.module !== undefined && "plugin" in plugin.module
              ? plugin.module.plugin
              : undefined
            : carriers[index];
        if (carrier === undefined) continue;
        if (!Predicate.isObject(carrier)) continue;
        const candidate = "doctorChecks" in carrier ? carrier.doctorChecks : undefined;
        if (candidate === undefined) continue;
        if (!Array.isArray(candidate)) return Result.fail(mismatch("doctorChecks must be an array."));
        const name = "name" in carrier ? carrier.name : undefined;
        const manifest = "manifest" in carrier ? carrier.manifest : undefined;
        const decodedManifest =
          manifest === undefined ? undefined : Schema.decodeUnknownResult(PluginManifest)(manifest);
        if (
          ((index === 0 || index === 2) && (name === undefined || manifest === undefined)) ||
          (name !== undefined && name !== pluginName) ||
          (decodedManifest !== undefined &&
            (Result.isFailure(decodedManifest) || decodedManifest.success.name !== pluginName))
        ) {
          return Result.fail(mismatch("doctor descriptor identity disagrees with the loaded manifest."));
        }
        collection = candidate;
        break;
      }
      if (collection === undefined) continue;
      // Snapshot accessors and bind callbacks once while the projection is protected.
      for (const check of collection) {
        if (!Predicate.isObject(check)) return Result.fail(mismatch("invalid doctor check."));
        const id = "id" in check ? check.id : undefined;
        const run = "run" in check ? check.run : undefined;
        const relevant = "relevant" in check ? check.relevant : undefined;
        if (
          typeof id !== "string" ||
          id.trim().length === 0 ||
          typeof run !== "function" ||
          (relevant !== undefined && typeof relevant !== "function")
        ) {
          return Result.fail(
            mismatch("doctor checks require a nonempty id, callable run, and optional callable relevant."),
          );
        }
        if (checks.has(id)) return Result.fail(mismatch(`duplicate doctorChecks id ${id}.`));
        checks.set(id, {
          id,
          run: Function.prototype.bind.call(run, check) as PluginDoctorCheckContribution["run"],
          ...(relevant === undefined
            ? {}
            : {
                relevant: Function.prototype.bind.call(relevant, check) as NonNullable<
                  PluginDoctorCheckContribution["relevant"]
                >,
              }),
        });
      }
    } catch {
      return Result.fail(mismatch("doctor descriptor could not be inspected safely."));
    }
  }
  return Result.succeed(checks);
};
