/**
 * Lando-owned locations for generated service leaf certificates.
 *
 * The planner records these paths as bind sources, apply copies issued
 * material into them, and destroy removes the owner's directory. Keying by the
 * app owner (not the app name) keeps two apps that share a name apart and keeps
 * the files stable across a rename.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { makeLandoPaths } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { MessageWarnEvent } from "@lando/sdk/events";
import { EventService, PathsService } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";

export const serviceCertificatesOwnerDir = (certsDir: string, ownerKey: string): string =>
  join(certsDir, "services", ownerKey);

export interface ServiceCertificatePaths {
  readonly certPath: string;
  readonly keyPath: string;
}

/**
 * The file stem is a lowercased, sanitised service name for recognition plus a digest of the exact
 * name. Hosts with case-insensitive filesystems (Windows, macOS) would otherwise fold `web` and
 * `WEB` onto one file, and the suffix keeps every stem off Windows reserved device names (`aux`).
 */
export const serviceCertificatePaths = (
  certsDir: string,
  ownerKey: string,
  serviceName: string,
): ServiceCertificatePaths => {
  const dir = serviceCertificatesOwnerDir(certsDir, ownerKey);
  const readable = serviceName
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, "-")
    .slice(0, 48);
  const stem = `${readable}-${sha256Hex(serviceName).slice(0, 12)}`;
  return { certPath: join(dir, `${stem}.crt`), keyPath: join(dir, `${stem}.key`) };
};

export const resolveCertsDir = Effect.fnUntraced(function* () {
  const paths = yield* Effect.serviceOption(PathsService);
  return Option.isSome(paths) ? paths.value.certsDir : makeLandoPaths().certsDir;
});

/**
 * Remove one owner's generated leaf material after its teardown succeeded.
 * A failure leaves private key material behind, so it is reported, not hidden.
 */
export const removeServiceCertificates = Effect.fn("ServiceCertificates.remove")(function* (
  ownerKey: string,
) {
  const dir = serviceCertificatesOwnerDir(yield* resolveCertsDir(), ownerKey);
  const removed = yield* Effect.tryPromise(() => rm(dir, { recursive: true, force: true })).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (removed) return;
  const events = yield* EventService;
  yield* events.publish(
    MessageWarnEvent.make({
      body: `Unable to remove generated service certificates at ${dir}. Remove that directory manually.`,
      timestamp: DateTime.nowUnsafe(),
    }),
  );
});
