import { createHash } from "node:crypto";
import type { ServiceExecError } from "@lando/sdk/errors";
import type { ContainerHelperArtifact } from "@lando/sdk/schema";
import { Effect } from "effect";

const artifacts = new Map<string, { readonly bytes: Uint8Array; readonly digest: string }>();

export const verifiedExecHelper = (
  helper: ContainerHelperArtifact,
  failure: (stage: string) => ServiceExecError,
) =>
  Effect.gen(function* () {
    const key = `${helper.path}:${helper.digest}`;
    const cached = artifacts.get(key);
    if (cached !== undefined) return cached;
    const bytes = yield* Effect.tryPromise({
      try: () => Bun.file(helper.path).bytes(),
      catch: () => failure("helper-read"),
    });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== helper.digest) return yield* Effect.fail(failure("helper-digest"));
    const artifact = { bytes, digest };
    artifacts.set(key, artifact);
    return artifact;
  });
