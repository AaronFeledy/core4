import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";

import type { AppPlan } from "@lando/sdk/schema";
import type { ProcessRunner } from "@lando/sdk/services";
import type { Context } from "effect";

import {
  windowsStdinExec,
  windowsStdinExecArgs,
  windowsStdinExecSpawnEnv,
  windowsStdinExecStream,
} from "../src/windows-stdin-exec.ts";

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
      "lando-demo-app--db",
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
    } as unknown as Context.Service.Shape<typeof ProcessRunner>;
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
    expect(receivedEnv?.SQL_PASSWORD).toBe("secret value");
    expect(receivedEnv).toBeDefined();
    expect(receivedArgs.join(" ")).not.toContain("secret value");
    expect(result).toEqual({ stdout: "after EOF", stderr: "warning", exitCode: 37 });
    expect([...chunks].map((chunk) => ("exitCode" in chunk ? chunk.exitCode : chunk.kind))).toEqual([
      "stdout",
      "stderr",
      37,
    ]);
  });

  test("windowsStdinExecSpawnEnv strips Podman redirects and keeps command env", () => {
    const env = windowsStdinExecSpawnEnv(
      { SQL_PASSWORD: "secret value" },
      {
        PATH: "/bin",
        HOME: "/home/user",
        CONTAINER_HOST: "unix:///hostile.sock",
        CONTAINER_CONNECTION: "other",
        CONTAINERS_CONF_OVERRIDE: "/tmp/override.conf",
        _PODMAN_PAUSE: "1",
        HTTP_PROXY: "http://proxy.example",
      },
    );

    expect(env.SQL_PASSWORD).toBe("secret value");
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/user");
    expect(env.HTTP_PROXY).toBe("http://proxy.example");
    expect(env).not.toHaveProperty("CONTAINER_HOST");
    expect(env).not.toHaveProperty("CONTAINER_CONNECTION");
    expect(env).not.toHaveProperty("CONTAINERS_CONF_OVERRIDE");
    expect(env).not.toHaveProperty("_PODMAN_PAUSE");
  });

  test("always passes sanitized env even when command.env is omitted", async () => {
    let receivedEnv: Readonly<Record<string, string>> | undefined;
    let replaceEnv: boolean | undefined;
    const runner = {
      run: (options: { readonly env?: Readonly<Record<string, string>>; readonly replaceEnv?: boolean }) =>
        Effect.sync(() => {
          receivedEnv = options.env;
          replaceEnv = options.replaceEnv;
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      stream: () => Stream.empty,
      streamWithExit: () => Stream.empty,
    } as unknown as Context.Service.Shape<typeof ProcessRunner>;

    await Effect.runPromise(
      windowsStdinExec(
        plan,
        target,
        { command: ["true"] },
        {
          podmanBin: "podman",
          connectionName: "lando-root",
          processRunner: runner,
        },
      ),
    );

    expect(receivedEnv).toBeDefined();
    expect(receivedEnv).not.toHaveProperty("CONTAINER_HOST");
    // The runner extends the host environment unless told to replace it.
    expect(replaceEnv).toBe(true);
  });
});
