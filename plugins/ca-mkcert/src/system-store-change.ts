/**
 * Trusting the local CA in the system store, as a planned host change. The downloaded mkcert never
 * runs as root, and outside Windows Lando never runs `mkcert -install`: Lando reads the root as the
 * user, checks that the bytes are exactly one CA certificate with the digest it planned, and pipes
 * them to fixed root commands that write a file inside a root-owned directory. Root never reads a
 * path the user controls, so a swapped symlink cannot make it publish another file.
 *
 * Planning only reads: it finds `CAROOT` the way mkcert does, reads the root when one exists, and
 * reads the system store fresh. A missing root is untrusted by definition, so the change is
 * certain; only its digest waits for setup to create the root. Native Windows runs
 * `mkcert -install` unprivileged for the user's store, which shows Windows' own Security Warning.
 */
import { mapFailures } from "@lando/sdk/command-result";
import { type CaError, HostChangeFailedError, HostChangeStaleError } from "@lando/sdk/errors";
import type { HostPlatform, TrustStoreStatus } from "@lando/sdk/schema";
import type {
  HostChangeApplyError,
  HostChangeApplyResult,
  HostChangeProposal,
  HostChangeStepRunner,
  ProcessResult,
} from "@lando/sdk/services";
import { Effect } from "effect";

import type { HostEnv } from "./homebrew-trust.ts";
import { sha1Hex } from "./host-trust.ts";
import { failureDetail } from "./mkcert-command.ts";
import {
  type SystemStoreTarget,
  TRUST_SYSTEM_STORE,
  macosUndo,
  rootPemProblem,
  sha256,
  systemStoreChange,
  windowsUndo,
} from "./system-store-declaration.ts";
import {
  MACOS_STAGED_ROOT,
  MACOS_STAGE_DIR,
  detectLinuxAnchorStore,
  landoAnchorPath,
} from "./system-trust.ts";
import { mkcertCaRoot } from "./uninstall-trust.ts";

const SKIP_HINT = "or rerun with `lando setup --skip-install-ca` and trust the local CA yourself";

export interface SystemStoreChangeInput {
  readonly platform: string;
  readonly env: HostEnv;
  /** The pinned mkcert binary; only native Windows runs it for trust. */
  readonly binary: string;
  readonly exists: (path: string) => boolean;
  /** The root in `caroot`, or undefined when there is none yet. Reads only. */
  readonly readRoot: (caroot: string) => Effect.Effect<string | undefined, CaError>;
  /** A fresh read of the system store's view of `root`. */
  readonly inspect: (caroot: string, root: string) => Effect.Effect<TrustStoreStatus>;
  /** The directory mkcert reports and the root setup ensured in it; applies only after setup created it. */
  readonly ensuredRoot: Effect.Effect<{ readonly caroot: string; readonly root: string }, CaError>;
}

const hostPlatform = (platform: string): HostPlatform =>
  platform === "darwin" || platform === "win32" ? platform : "linux";

export { rootPemProblem } from "./system-store-declaration.ts";

const failed = (message: string, remediation: string, stepId?: string, result?: ProcessResult) =>
  new HostChangeFailedError({
    changeId: TRUST_SYSTEM_STORE,
    message,
    remediation,
    ...(stepId === undefined ? {} : { stepId }),
    ...(result === undefined ? {} : { exitCode: result.exitCode, stderr: result.stderr }),
  });

const stale = (reason: string) =>
  new HostChangeStaleError({
    changeId: TRUST_SYSTEM_STORE,
    reason,
    message: `The local CA changed after setup planned to trust it (${reason}), so Lando did not trust it.`,
    remediation: "Rerun `lando setup` so Lando can plan it again.",
  });

const runStep = Effect.fnUntraced(function* (
  steps: HostChangeStepRunner,
  stepId: string,
  failure: { readonly message: string; readonly remediation: string },
  stdin?: Uint8Array,
) {
  const result = yield* steps.run(stepId, stdin === undefined ? undefined : { stdin });
  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      failed(`${failure.message}: ${failureDetail(result)}.`, failure.remediation, stepId, result),
    );
  }
  return result;
});

const caFailure = (cause: CaError) => failed(cause.message, cause.remediation);

export const makeSystemStoreChange = (input: SystemStoreChangeInput) => {
  const platform = hostPlatform(input.platform);

  const target = (caroot: string | undefined): SystemStoreTarget | undefined => {
    switch (platform) {
      case "darwin":
        return { kind: "darwin" };
      case "win32":
        return caroot === undefined ? undefined : { kind: "win32", caroot };
      default: {
        const store = detectLinuxAnchorStore(input.exists);
        return store === undefined ? undefined : { kind: "linux", store };
      }
    }
  };

  const proposal = (
    planned: SystemStoreTarget,
    root: string | undefined,
    caroot: string | undefined,
  ): HostChangeProposal => {
    const change = systemStoreChange(planned, input, root, caroot);
    const plannedDigest = root === undefined ? undefined : sha256(root);
    return {
      change,
      apply: Effect.fnUntraced(function* (steps): Effect.fn.Return<
        HostChangeApplyResult,
        HostChangeApplyError
      > {
        const { caroot, root: ensured } = yield* input.ensuredRoot.pipe(mapFailures(caFailure));
        const problem = rootPemProblem(ensured);
        if (problem !== undefined) {
          return yield* Effect.fail(
            failed(
              `Lando will not trust the local CA in ${caroot} because ${problem}.`,
              `Move ${caroot} aside so \`lando setup\` creates a new local CA, ${SKIP_HINT}.`,
            ),
          );
        }
        const digest = sha256(ensured);
        if (plannedDigest !== undefined && digest !== plannedDigest) {
          return yield* Effect.fail(stale("its certificate differs from the one setup planned with"));
        }
        if (planned.kind === "win32" && caroot !== planned.caroot) {
          return yield* Effect.fail(stale(`mkcert now reports ${caroot} as its CA directory`));
        }
        if ((yield* input.inspect(caroot, ensured)).state === "trusted") return { changed: false };
        const bytes = new TextEncoder().encode(ensured);
        const facts = { sha256: digest };
        switch (planned.kind) {
          case "linux": {
            const remediation = `Fix the problem it reports and rerun \`lando setup\`, ${SKIP_HINT}.`;
            const writeFailure = {
              message: `Lando could not write the local CA to ${landoAnchorPath(planned.store)}`,
              remediation,
            };
            yield* runStep(steps, "write-anchor", writeFailure, bytes);
            yield* runStep(steps, "chmod-anchor", writeFailure);
            yield* runStep(steps, "refresh", {
              message: `\`${planned.store.refresh.join(" ")}\` failed after Lando added the local CA`,
              remediation,
            });
            return { changed: true, facts };
          }
          case "darwin": {
            const remediation = `Rerun \`lando setup\` in a desktop session and approve macOS's dialog, ${SKIP_HINT}.`;
            yield* runStep(steps, "stage-dir", {
              message: `Lando could not create ${MACOS_STAGE_DIR}`,
              remediation,
            });
            yield* runStep(
              steps,
              "stage",
              { message: `Lando could not write the local CA to ${MACOS_STAGED_ROOT}`, remediation },
              bytes,
            );
            yield* runStep(steps, "trust", { message: "macOS did not trust the local CA", remediation });
            return { changed: true, facts, undo: macosUndo(sha1Hex(ensured)) };
          }
          case "win32":
            yield* runStep(steps, "install", {
              message: "mkcert could not add the local CA to the Windows certificate store",
              remediation: `Approve Windows' Security Warning when you rerun \`lando setup\`, ${SKIP_HINT}.`,
            });
            return { changed: true, facts, undo: windowsUndo(sha1Hex(ensured)) };
          default: {
            const exhaustive: never = planned;
            return exhaustive;
          }
        }
      }),
    };
  };

  /** Read-only: the change trusting the root needs, or none when the store trusts it or Lando cannot write it. */
  const plan = Effect.fnUntraced(function* (): Effect.fn.Return<ReadonlyArray<HostChangeProposal>, CaError> {
    const caroot = mkcertCaRoot(platform, input.env);
    const planned = target(caroot);
    if (planned === undefined) return [];
    const root = caroot === undefined ? undefined : yield* input.readRoot(caroot);
    if (
      caroot !== undefined &&
      root !== undefined &&
      (yield* input.inspect(caroot, root)).state === "trusted"
    ) {
      return [];
    }
    return [proposal(planned, root, caroot)];
  });

  return { plan };
};
