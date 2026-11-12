/** Running the pinned mkcert binary and shaping its failures as `CaError`s. */

import { mapFailures } from "@lando/sdk/command-result";
import { CaError } from "@lando/sdk/errors";
import type { ProcessResult, ProcessRunner } from "@lando/sdk/services";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { type Context, Effect } from "effect";

export const CA_ID = "mkcert" as const;

export const SETUP_REMEDIATION = "Run `lando setup` to download mkcert and install the local CA.";

const REPAIR_REMEDIATION = `Repair the ${CA_ID} certificate authority (install mkcert via lando setup, trust the CA, then re-run).`;

export const caError = (
  message: string,
  {
    cause,
    remediation = REPAIR_REMEDIATION,
  }: { readonly cause?: unknown; readonly remediation?: string } = {},
): CaError =>
  new CaError({
    message,
    caId: CA_ID,
    ...(cause === undefined ? {} : { cause }),
    remediation,
  });

export const failureDetail = (result: ProcessResult): string => {
  const detail = (result.stderr.trim().length > 0 ? result.stderr : result.stdout).trim();
  return detail.length === 0 ? `exit code ${result.exitCode}` : detail;
};

export const makeRunMkcert = (processRunner: Context.Service.Shape<typeof ProcessRunner>, binary: string) =>
  Effect.fn("Mkcert.run")(
    (args: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) =>
      processRunner.run({ cmd: binary, args, ...(env === undefined ? {} : { env }) }),
    mapFailures((cause) => caError(`Failed to run mkcert: ${cause.message}`, { cause })),
  );

export type RunMkcert = ReturnType<typeof makeRunMkcert>;

/** What the root and issuance operations share; built once per authority. */
export interface MkcertContext {
  readonly binDir: string;
  readonly platform: string;
  readonly arch: string;
  readonly binary: string;
  readonly privateFileAccess: PrivateFileAccess;
  readonly runMkcert: RunMkcert;
}
