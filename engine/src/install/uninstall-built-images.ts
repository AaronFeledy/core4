import { BUILT_ARTIFACT_PREFIX } from "@lando/container-runtime/image-build";
import { normalizeImageRef } from "@lando/container-runtime/image-list";
import { causeMessage } from "@lando/sdk/errors";
import { Schema } from "effect";
import { BUILT_ARTIFACT_STORE_LABEL } from "../services/build-artifact-name.ts";
import { UninstallResourceCleanupError } from "./uninstall-cleanup-error.ts";
import { type RuntimeExec, type UninstallRuntime, runUninstallRuntime } from "./uninstall-runtime.ts";

const ImageInspection = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      RepoTags: Schema.NullOr(Schema.Array(Schema.String)),
      Config: Schema.Struct({ Labels: Schema.NullOr(Schema.Record(Schema.String, Schema.String)) }),
    }),
  ),
);

const bareImageId = (id: string): string => id.replace(/^sha256:/u, "");

export const cleanupUninstallBuiltImages = async (
  exec: RuntimeExec,
  runtime: UninstallRuntime,
  store: string,
): Promise<string> => {
  const removed: string[] = [];
  const retained: string[] = [];
  const failed: string[] = [];
  const run = (args: readonly string[]) => runUninstallRuntime(exec, runtime, { args, timeout: 60_000 });
  const prefix = `${BUILT_ARTIFACT_PREFIX}${store}-`;
  try {
    // The default listing shows tagged images and dangling leaves, never parents: removing each one
    // prunes its own untagged parents, and a parent removed that way is never inspected afterwards.
    const listed = await run([
      "images",
      "--no-trunc",
      "--filter",
      `label=${BUILT_ARTIFACT_STORE_LABEL}=${store}`,
      "--format",
      "{{.ID}}",
    ]);
    const ids = new Set(
      listed.stdout
        .split(/\r?\n/u)
        .map((id) => id.trim())
        .filter(Boolean),
    );
    for (const id of ids) {
      const resource = `${runtime.cmd} image ${id}`;
      try {
        const images = Schema.decodeUnknownSync(ImageInspection)(
          (await run(["image", "inspect", id])).stdout,
        );
        const image = images[0];
        // `images --no-trunc` prints `sha256:<hex>` on both engines, but Podman's inspect `Id` is bare hex.
        if (images.length !== 1 || image === undefined || bareImageId(image.Id) !== bareImageId(id)) {
          failed.push(`${resource}: exact native identity unavailable`);
          continue;
        }
        if (image.Config.Labels?.[BUILT_ARTIFACT_STORE_LABEL] !== store) {
          retained.push(`${resource}: build-store ownership changed`);
          continue;
        }
        const tags = (image.RepoTags ?? []).filter((tag) => tag !== "<none>:<none>");
        // Podman qualifies built names with docker.io/library/ (compat builds) or localhost/.
        const owned = tags.filter((tag) => normalizeImageRef(tag).startsWith(prefix));
        const foreign = tags.filter((tag) => !owned.includes(tag));
        if (foreign.length > 0) retained.push(`${resource}: foreign tags ${foreign.join(", ")}`);
        for (const ref of tags.length === 0 ? [image.Id] : owned) {
          const reference = `${runtime.cmd} image ${ref}`;
          try {
            await run(["image", "rm", ref]);
            removed.push(reference);
          } catch (cause) {
            const message = causeMessage(cause);
            if (/in use|being used|used by|is using its referenced image|dependent child/iu.test(message))
              retained.push(`${reference}: in use: ${message}`);
            else failed.push(`${reference}: ${message}`);
          }
        }
      } catch (cause) {
        failed.push(`${resource}: ${causeMessage(cause)}`);
      }
    }
  } catch (cause) {
    failed.push(`${runtime.cmd}: image discovery failed: ${causeMessage(cause)}`);
  }
  const detail = `Built images on ${runtime.cmd}. Removed: ${removed.length}${removed.length === 0 ? "" : ` (${removed.join("; ")})`}. Retained: ${retained.join("; ") || "none"}. Failed: ${failed.join("; ") || "none"}.`;
  if (failed.length > 0)
    throw new UninstallResourceCleanupError({
      message: detail,
      removed,
      retained,
      failed,
      remediation:
        "Inspect failed images before retrying purge. Cache and uninstall state must be preserved.",
    });
  return detail;
};
