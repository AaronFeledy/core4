import { rm } from "node:fs/promises";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";
import { SourceAcquisitionError, acquisitionError, displaySource } from "./errors.ts";
import { isLiteralGitRef } from "./locator.ts";
import type { GitTransport } from "./types.ts";
export type { GitTransport } from "./types.ts";

export const makeGitTransport = (runner: typeof ProcessRunner.Service): GitTransport => ({
  fetch: async ({ url, ref, dest, signal }) => {
    if (ref !== undefined && !isLiteralGitRef(ref))
      throw new SourceAcquisitionError({
        message: `Invalid git ref: ${displaySource(ref)}`,
        source: displaySource(url),
        kind: "invalid-locator",
        remediation: "Choose a literal tag, branch, or full commit SHA.",
      });
    const run = async (args: readonly string[]): Promise<string> => {
      const result = await Effect.runPromise(
        runner
          .run({
            cmd: "git",
            args,
            capture: true,
            ...(signal === undefined ? {} : { signal }),
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "",
              SSH_ASKPASS: "",
              GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
            },
          })
          .pipe(Effect.mapError((cause) => acquisitionError("fetch-failed", url, cause))),
        signal === undefined ? undefined : { signal },
      );
      if (result.exitCode !== 0)
        throw acquisitionError(
          "fetch-failed",
          url,
          result.stderr.trim() || `git failed with exit code ${result.exitCode}`,
        );
      return result.stdout.trim();
    };
    await run(["init", "-q", dest]);
    await run(["-C", dest, "fetch", "-q", "--depth", "1", "--no-tags", "--", url, ref ?? "HEAD"]);
    await run([
      "-C",
      dest,
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "checkout",
      "-q",
      "--detach",
      "FETCH_HEAD",
    ]);
    const commit = await run(["-C", dest, "rev-parse", "HEAD"]);
    await rm(`${dest}/.git`, { recursive: true, force: true });
    return { commit };
  },
});
