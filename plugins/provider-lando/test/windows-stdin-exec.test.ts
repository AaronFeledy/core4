import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";

import type { AppPlan } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";
import type { Context } from "effect";

import { windowsStdinExec, windowsStdinExecArgs, windowsStdinExecStream } from "../src/windows-stdin-exec.ts";

const plan = { slug: "demo-app" } as AppPlan;
const target = { app: "demo-app", service: "db", user: "mysql" } as Parameters<typeof windowsStdinExec>[1];
async function* stdinStream() {
  yield new Uint8Array([65, 66]);
  yield new Uint8Array([67]);
}

describe("managed Windows stdin exec", () => {
  test("passes argv-precise container, user, cwd, env, and command to Podman CLI", () => {
    const args = windowsStdinExecArgs(
      plan,
      target,
      { command: ["sh", "-c", "printf '%s' '$HOME'"], cwd: "/app space", env: { FOO: "a b" } },
      "lando-root",
    );

    expect(args).toEqual([
      "--connection",
      "lando-root",
      "exec",
      "-i",
      "--user",
      "mysql",
      "--workdir",
      "/app space",
      "--env",
      "FOO",
      "lando-demo-app-db",
      "sh",
      "-c",
      "printf '%s' '$HOME'",
    ]);
  });

  test("streams stdin to ProcessRunner and preserves stdout, stderr, and exit code", async () => {
    const received: number[] = [];
    let receivedEnv: Readonly<Record<string, string>> | undefined;
    let receivedArgs: ReadonlyArray<string> = [];
    const runner = {
      run: (options: {
        readonly stdinStream?: AsyncIterable<Uint8Array>;
        readonly env?: Readonly<Record<string, string>>;
        readonly args: ReadonlyArray<string>;
      }) =>
        Effect.tryPromise({
          try: async () => {
            receivedEnv = options.env;
            receivedArgs = options.args;
            for await (const chunk of options.stdinStream ?? []) received.push(...chunk);
            return { stdout: "after EOF", stderr: "warning", exitCode: 37 };
          },
          catch: (cause) => cause,
        }),
      stream: () => Stream.empty,
      streamWithExit: (options: { readonly stdinStream?: AsyncIterable<Uint8Array> }) =>
        Stream.fromEffect(
          Effect.promise(async () => {
            for await (const chunk of options.stdinStream ?? []) received.push(...chunk);
          }),
        ).pipe(
          Stream.flatMap(() =>
            Stream.fromIterable([
              { kind: "stdout" as const, chunk: new TextEncoder().encode("after EOF") },
              { kind: "stderr" as const, chunk: new TextEncoder().encode("warning") },
              { exitCode: 37 },
            ]),
          ),
        ),
    } as unknown as Context.Tag.Service<typeof ProcessRunner>;
    const command = { command: ["cat"], stdinStream: stdinStream(), env: { SQL_PASSWORD: "secret value" } };
    const options = {
      podmanBin: "C:/runtime/podman.exe",
      connectionName: "lando-root",
      processRunner: runner,
    };

    const result = await Effect.runPromise(windowsStdinExec(plan, target, command, options));
    const chunks = await Effect.runPromise(
      Stream.runCollect(
        windowsStdinExecStream(plan, target, { ...command, stdinStream: stdinStream() }, options),
      ),
    );

    expect(received).toEqual([65, 66, 67, 65, 66, 67]);
    expect(receivedEnv).toEqual({ SQL_PASSWORD: "secret value" });
    expect(receivedArgs.join(" ")).not.toContain("secret value");
    expect(result).toEqual({ stdout: "after EOF", stderr: "warning", exitCode: 37 });
    expect([...chunks].map((chunk) => ("exitCode" in chunk ? chunk.exitCode : chunk.kind))).toEqual([
      "stdout",
      "stderr",
      37,
    ]);
  });
});
