/** Locating, reading and creating the shared mkcert root in `CAROOT`. */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { withAdvisoryLockUsing } from "@lando/state-store/lock";
import { Effect } from "effect";

import { mapFailures } from "@lando/sdk/command-result";
import { type CaError, isErrnoCode } from "@lando/sdk/errors";
import type { CaRootCertificate } from "@lando/sdk/services";

import type { IssueInto } from "./issuance.ts";
import { type MkcertContext, SETUP_REMEDIATION, caError, failureDetail } from "./mkcert-command.ts";
import { MKCERT_TOOL_VERSION, readInstalledMkcertStatus } from "./provision.ts";

const ROOT_FILE = "rootCA.pem";
/** Setup waits this long for another process that is creating the shared root. */
const ROOT_LOCK_TIMEOUT_MS = 120_000;

const readRootFile = (path: string): Promise<string | undefined> =>
  readFile(path, "utf8").catch((cause: unknown) => {
    if (isErrnoCode(cause, "ENOENT")) return undefined;
    throw cause;
  });

export const makeMkcertRoot = (
  { binDir, platform, arch, binary, privateFileAccess, runMkcert }: MkcertContext,
  issueInto: IssueInto,
) => {
  // `mkcert -CAROOT` only prints the directory; it never creates a root.
  const caRoot: Effect.Effect<string, CaError> = Effect.gen(function* () {
    const result = yield* runMkcert(["-CAROOT"]);
    const root = result.stdout.trim();
    if (result.exitCode !== 0 || root.length === 0) {
      return yield* Effect.fail(
        caError(`mkcert could not report its CA root: ${failureDetail(result)}.`, {
          remediation: SETUP_REMEDIATION,
        }),
      );
    }
    return root;
  });

  const requireBinary = Effect.gen(function* () {
    const installed = yield* Effect.promise(() => readInstalledMkcertStatus(binDir, platform, arch));
    if (!installed.isCurrent) {
      return yield* Effect.fail(
        caError(`mkcert ${MKCERT_TOOL_VERSION} is not installed at ${binary}.`, {
          remediation: SETUP_REMEDIATION,
        }),
      );
    }
  });

  const readRoot = (caroot: string) => {
    const path = join(caroot, ROOT_FILE);
    return Effect.tryPromise({
      try: () => readRootFile(path),
      catch: (cause) => caError(`Failed to read the mkcert local CA at ${path}.`, { cause }),
    });
  };

  /** The root and its directory; fails when setup has not created the root yet. */
  const currentRoot = Effect.gen(function* () {
    yield* requireBinary;
    const caroot = yield* caRoot;
    const certificate = yield* readRoot(caroot);
    if (certificate === undefined) {
      return yield* Effect.fail(
        caError(`mkcert has no local CA in ${caroot}.`, { remediation: SETUP_REMEDIATION }),
      );
    }
    return { caroot, root: { certificate } satisfies CaRootCertificate };
  });

  /** Create the shared root when `CAROOT` has none; an existing root is never replaced. */
  const ensureRoot = Effect.fn("Mkcert.ensureRoot")(function* (caroot: string) {
    yield* Effect.tryPromise({
      try: () => mkdir(caroot, { recursive: true, mode: 0o700 }),
      catch: (cause) => caError(`Failed to create the mkcert CA directory ${caroot}.`, { cause }),
    });
    const createWhenMissing = Effect.gen(function* () {
      if ((yield* readRoot(caroot)) !== undefined) return;
      // Any issuing run creates the root; the throwaway leaf goes away with its temporary directory.
      yield* issueInto(caroot, ["localhost"], async () => undefined);
    });
    yield* withAdvisoryLockUsing(privateFileAccess, {
      expireLiveOwner: false,
      timeoutMs: ROOT_LOCK_TIMEOUT_MS,
    })(join(caroot, "lando-root"), "mkcert-root", createWhenMissing).pipe(
      mapFailures((cause) =>
        cause._tag === "CaError"
          ? cause
          : caError(`Failed to lock the mkcert CA directory ${caroot}.`, {
              cause,
              remediation: `${cause.remediation} Then run \`lando setup\` again.`,
            }),
      ),
    );
  });

  return { caRoot, currentRoot, ensureRoot };
};
