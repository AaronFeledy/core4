import { dataHelperImage } from "@lando/container-runtime/data-plane";
import {
  type AppPlan,
  type ServiceDataVersion,
  type VolumeMountPlan,
  parseDataVersionRecords,
} from "@lando/sdk/schema";
import type { ExecResult, RuntimeProviderShape } from "@lando/sdk/services";
import { Effect } from "effect";

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
}) {
  const { provider, appliedPlan, mount, contract } = input;
  const paths = contract.series?.records.map(({ path }) => path) ?? [];
  if (paths.length === 0 || paths.some((path) => !path.startsWith(`${mount.target}/`))) return undefined;
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
    Effect.timeout("2 seconds"),
    Effect.map((read) => decodeVersionRecords(read, paths, contract)?.version),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});
