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

  test("rejects buffered and streamed stdin before spawning an unsupervised command", async () => {
    let spawned = false;
    const runner = {
      run: () => {
        spawned = true;
        return Effect.die("unexpected spawn");
      },
      stream: () => {
        spawned = true;
        return Stream.die("unexpected spawn");
      },
      streamWithExit: () => {
        spawned = true;
        return Stream.die("unexpected spawn");
      },
    } as unknown as Context.Service.Shape<typeof ProcessRunner>;
    const command = { command: ["cat"], stdinStream: stdinStream(), env: { SQL_PASSWORD: "secret value" } };
    const options = {
      podmanBin: "C:/runtime/podman.exe",
      connectionName: "lando-root",
      processRunner: runner,
    };
    const expected = {
      _tag: "ServiceExecError",
      providerId: "lando",
      service: "db",
      message: "Managed Windows stdin execution cannot confirm container command cleanup.",
    };
    await expect(Effect.runPromise(windowsStdinExec(plan, target, command, options))).rejects.toMatchObject(
      expected,
    );
    await expect(
      Effect.runPromise(Stream.runCollect(windowsStdinExecStream(plan, target, command, options))),
    ).rejects.toMatchObject(expected);
    expect(spawned).toBe(false);
  });
});
