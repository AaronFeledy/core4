import { dataHelperImage } from "@lando/container-runtime/data-plane";
import {
  type AppPlan,
  type ServiceDataVersion,
  type VolumeMountPlan,
  parseDataVersionRecords,
} from "@lando/sdk/schema";
import type { ExecResult, RuntimeProviderShape } from "@lando/sdk/services";
import { Effect, Option } from "effect";

const OFFLINE_HELPER_DEADLINE = "30 seconds";

type OfflineVersion =
  | { readonly kind: "verified"; readonly version: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable"; readonly reason: string };

export const versionRecordCommand = (paths: readonly string[]) => [
  "sh",
  "-c",
  `for file do
    test -x "\${file%/*}" || exit 1
    resolved=$(readlink -f -- "$file") && test "$resolved" = "$file" || exit 1
    if test -e "$file" || test -L "$file"; then
      test -f "$file" && test ! -L "$file" || exit 1
      printf '+'
      head -c 4097 -- "$file" || exit 1
    else
      printf '-'
    fi
    printf '\\000'
  done`,
  "lando-data-version",
  ...paths,
];

export const decodeVersionRecords = (
  read: ExecResult,
  paths: readonly string[],
  contract: ServiceDataVersion,
) => {
  if (read.exitCode !== 0) return undefined;
  const contents = read.stdout.split("\0");
  if (contents.length !== paths.length + 1 || contents.at(-1) !== "") return undefined;
  const files = new Map<string, string>();
  for (const [index, path] of paths.entries()) {
    const frame = contents[index];
    if (frame === "-") continue;
    if (frame?.startsWith("+") !== true) return undefined;
    const content = frame.slice(1);
    if (Buffer.byteLength(content) <= 4096) files.set(path, content);
  }
  return {
    version: parseDataVersionRecords(files, contract),
    missing: contents.slice(0, -1).every((frame) => frame === "-"),
  };
};

export const prepareSnapshotHelper = (provider: RuntimeProviderShape) =>
  provider.capabilities.artifactPull
    ? provider.pullArtifact({ ref: dataHelperImage.ref, policy: "missing" }).pipe(Effect.asVoid)
    : Effect.void;

export const readOfflineVersion = Effect.fn("AppActivation.readOfflineDatabaseVersion")(function* (input: {
  readonly provider: RuntimeProviderShape;
  readonly appliedPlan: AppPlan;
  readonly mount: VolumeMountPlan;
  readonly contract: ServiceDataVersion;
}): Effect.fn.Return<OfflineVersion> {
  const { provider, appliedPlan, mount, contract } = input;
  const paths = contract.series?.records.map(({ path }) => path) ?? [];
  if (paths.length === 0) return { kind: "missing" };
  if (paths.some((path) => !path.startsWith(`${mount.target}/`)))
    return { kind: "unavailable", reason: "a version record is outside the database volume" };
  return yield* Effect.scoped(
    provider.run({
      owner: { app: appliedPlan.id, plan: appliedPlan },
      image: dataHelperImage.ref,
      mounts: [{ ...mount, readOnly: true }],
      command: versionRecordCommand(paths),
      captureStdout: true,
      remove: true,
    }),
  ).pipe(
    Effect.timeoutOption(OFFLINE_HELPER_DEADLINE),
    Effect.match({
      onFailure: (): OfflineVersion => ({ kind: "unavailable", reason: "the storage helper failed" }),
      onSuccess: (read): OfflineVersion => {
        if (Option.isNone(read)) return { kind: "unavailable", reason: "the storage helper timed out" };
        const records = decodeVersionRecords(read.value, paths, contract);
        if (records?.version !== undefined) return { kind: "verified", version: records.version };
        return records?.missing === true
          ? { kind: "missing" }
          : { kind: "unavailable", reason: "the storage helper could not read a usable version record" };
      },
    }),
  );
});
