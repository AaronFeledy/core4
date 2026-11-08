import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedNetworkTrust } from "@lando/sdk/network-trust";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";
import { SourceAcquisitionError, acquisitionError, displaySource } from "./errors.ts";
import { type GitNetworkProjection, type GitTransportOptions, withGitTrust } from "./git-trust.ts";
import { isLiteralGitRef } from "./locator.ts";
import type { GitTransport } from "./types.ts";
export type { GitTransport } from "./types.ts";

/** HTTP(S) uses resolved Lando trust; SSH/scp URLs use SSH configuration unchanged. */
export const makeGitTransport = (
  runner: typeof ProcessRunner.Service,
  transportOptions: GitTransportOptions = { systemCaPems: () => [] },
): GitTransport => {
  // One resolution per transport: ls-remote and fetch for the same acquisition share it.
  let trust: Promise<ResolvedNetworkTrust | undefined> | undefined;
  const resolveTrust = transportOptions.trust;
  const options: GitTransportOptions =
    typeof resolveTrust === "function"
      ? {
          ...transportOptions,
          trust: () => {
            trust ??= resolveTrust().catch((cause: unknown) => {
              trust = undefined;
              throw cause;
            });
            return trust;
          },
        }
      : transportOptions;
  const command = (input: { readonly url: string; readonly ref?: string; readonly signal?: AbortSignal }) => {
    if (input.ref !== undefined && !isLiteralGitRef(input.ref))
      throw new SourceAcquisitionError({
        message: `Invalid git ref: ${displaySource(input.ref)}`,
        source: displaySource(input.url),
        kind: "invalid-locator",
        remediation: "Choose a literal tag, branch, or full commit SHA.",
      });
    return async (args: readonly string[], projection?: GitNetworkProjection): Promise<string> => {
      const result = await Effect.runPromise(
        runner
          .run({
            cmd: "git",
            args: [...(projection?.args ?? []), ...args],
            capture: true,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "",
              SSH_ASKPASS: "",
              GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
              ...projection?.env,
            },
          })
          .pipe(
            Effect.mapError((cause) =>
              acquisitionError(
                "fetch-failed",
                input.url,
                projection?.redact === undefined ? cause : projection.redact(cause.message),
              ),
            ),
          ),
        input.signal === undefined ? undefined : { signal: input.signal },
      );
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || `git failed with exit code ${result.exitCode}`;
        throw acquisitionError("fetch-failed", input.url, projection?.redact?.(message) ?? message);
      }
      return result.stdout.trim();
    };
  };
  return {
    resolve: async (input) => {
      const run = command(input);
      const ref = input.ref ?? "HEAD";
      const names =
        ref === "HEAD" || ref.startsWith("refs/") ? [ref] : [`refs/tags/${ref}`, `refs/heads/${ref}`];
      const patterns = names.flatMap((name) => [name, `${name}^{}`]);
      const output = await withGitTrust(input.url, options, (projection) =>
        run(["ls-remote", "--", input.url, ...patterns], projection),
      );
      const refs = new Map<string, string>();
      for (const line of output.split("\n")) {
        const match = /^([a-f\d]{40})\s+(\S+)$/iu.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) refs.set(match[2], match[1].toLowerCase());
      }
      // A short name shared by a branch and tag is left to fetch's DWIM rules.
      const [name, other] = names.filter((name) => refs.has(name));
      if (name === undefined || other !== undefined) return undefined;
      return refs.get(`${name}^{}`) ?? refs.get(name);
    },
    fetch: async (input) => {
      const run = command(input);
      const { url, ref, dest } = input;
      await run(["init", "-q", "--template=", dest]);
      const local = ["-C", dest, "-c", `core.hooksPath=${join(dest, ".git", "lando-no-hooks")}`];
      await withGitTrust(url, options, (projection) =>
        run([...local, "fetch", "-q", "--depth", "1", "--no-tags", "--", url, ref ?? "HEAD"], projection),
      );
      await mkdir(join(dest, ".git", "info"), { recursive: true });
      await writeFile(
        join(dest, ".git", "info", "attributes"),
        "* -text -filter -ident !eol !working-tree-encoding\n",
      );
      await run([
        ...local,
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
      await rm(join(dest, ".git"), { recursive: true, force: true });
      return { commit };
    },
  };
};
