import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ProcessResult, ProcessRunner, ProcessSpawnOptions } from "@lando/sdk/services";
import { type Context, Effect, Stream } from "effect";

export interface NssEntry {
  readonly nickname: string;
  /** `SSL,S/MIME,JAR/XPI` trust attributes. */
  readonly trust: string;
  readonly pem: string;
}

export interface FakeCertutil {
  readonly service: Context.Service.Shape<typeof ProcessRunner>;
  readonly calls: () => ReadonlyArray<{ readonly cmd: string; readonly args: ReadonlyArray<string> }>;
  readonly entries: (dir: string) => ReadonlyArray<NssEntry> | undefined;
}

const BAD_DATABASE = "certutil: function failed: SEC_ERROR_BAD_DATABASE: security library: bad database.";

const listing = (entries: ReadonlyArray<NssEntry>): string =>
  [
    "",
    `${"Certificate Nickname".padEnd(61)}Trust Attributes`,
    `${"".padEnd(61)}SSL,S/MIME,JAR/XPI`,
    "",
    ...entries.map(({ nickname, trust }) => `${nickname.padEnd(61)}${trust}`),
    "",
  ].join("\n");

/**
 * NSS's certutil over in-memory databases keyed by directory, answering `-L`, `-L -n <nick> -a` and
 * `-A` like the real tool. Every other command goes to `fallback`. A run without a timeout dies.
 */
export const makeFakeCertutil = (
  databases: Readonly<Record<string, ReadonlyArray<NssEntry>>> = {},
  options: {
    readonly addError?: string;
    readonly fallback?: Context.Service.Shape<typeof ProcessRunner>;
  } = {},
): FakeCertutil => {
  const state = new Map(Object.entries(databases).map(([dir, entries]) => [dir, [...entries]]));
  const calls: Array<{ readonly cmd: string; readonly args: ReadonlyArray<string> }> = [];

  const answer = async ({ args }: ProcessSpawnOptions): Promise<ProcessResult> => {
    const dir = (args[args.indexOf("-d") + 1] ?? "").replace(/^sql:/u, "");
    const entries = state.get(dir);
    if (entries === undefined) return { exitCode: 255, stdout: "", stderr: BAD_DATABASE };
    const nickname = args.includes("-n") ? args[args.indexOf("-n") + 1] : undefined;
    if (args[0] === "-A") {
      if (options.addError !== undefined) return { exitCode: 255, stdout: "", stderr: options.addError };
      const pem = await readFile(args[args.indexOf("-i") + 1] ?? "", "utf8");
      entries.push({ nickname: nickname ?? "", trust: args[args.indexOf("-t") + 1] ?? "", pem });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (nickname === undefined) return { exitCode: 0, stdout: listing(entries), stderr: "" };
    const pems = entries.filter((entry) => entry.nickname === nickname).map(({ pem }) => pem);
    if (pems.length === 0) return { exitCode: 255, stdout: "", stderr: "certutil: Could not find cert" };
    return { exitCode: 0, stdout: pems.join("\n"), stderr: "" };
  };

  return {
    service: {
      run: (input) => {
        if (basename(input.cmd) !== "certutil") {
          return options.fallback?.run(input) ?? Effect.die(new Error(`unexpected run: ${input.cmd}`));
        }
        if (input.timeoutMs === undefined) return Effect.die(new Error("certutil ran without a timeout"));
        calls.push({ cmd: input.cmd, args: [...input.args] });
        return Effect.promise(() => answer(input));
      },
      stream: () => Stream.die(new Error("unused")),
      streamWithExit: () => Stream.die(new Error("unused")),
    },
    calls: () => [...calls],
    entries: (dir) => state.get(dir),
  };
};
