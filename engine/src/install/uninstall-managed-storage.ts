import { Result, Schema } from "effect";
import { UninstallResourceCleanupError } from "./uninstall-cleanup-error.ts";
import { type RuntimeExec, type UninstallRuntime, runUninstallRuntime } from "./uninstall-runtime.ts";

const Usage = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ Type: Schema.String, Total: Schema.Number })),
);

export const assertManagedStorageResolved = async (
  exec: RuntimeExec,
  runtime: UninstallRuntime,
): Promise<void> => {
  if (!runtime.managed) return;
  const usage = await runUninstallRuntime(exec, runtime, { args: ["system", "df", "--format", "json"] });
  const decoded = Schema.decodeUnknownResult(Usage)(usage.stdout);
  const retained: string[] = [];
  if (Result.isFailure(decoded)) {
    retained.push("Managed storage usage could not be verified; detached data may remain.");
  } else {
    for (const type of ["Containers", "Local Volumes"]) {
      const rows = decoded.success.filter((row) => row.Type === type);
      const count = rows[0]?.Total;
      if (rows.length !== 1 || count === undefined || !Number.isInteger(count) || count < 0)
        retained.push(`Managed ${type} count is unverified.`);
      else if (count > 0)
        retained.push(
          `Managed storage retains ${count} ${type}; recover or explicitly remove them before purging storage.`,
        );
    }
  }
  if (retained.length > 0)
    throw new UninstallResourceCleanupError({
      message: `Incomplete managed storage cleanup: ${retained.join(" ")}`,
      removed: [],
      retained,
      failed: [],
      remediation:
        "Preserve the managed runtime, machine and state. Inspect remaining resources and recover their data before explicitly resolving them and retrying purge.",
    });
};
