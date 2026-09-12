import type { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";
import type { Context } from "effect";
import {
  type PrivateFileAccess,
  PrivateFileAccessLive,
  PrivateFileAccessService,
} from "../src/private-file-access.ts";

type PrivateFileAccessProcessRunner = Pick<Context.Tag.Service<typeof ProcessRunner>, "run">;

export const nativeProcessRunner: PrivateFileAccessProcessRunner = {
  run: (input) =>
    Effect.promise(async () => {
      const processHandle = Bun.spawn([input.cmd, ...input.args], {
        env: { ...process.env, ...input.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    }),
};

export const ownerOnlyFileAccess: PrivateFileAccess = {
  enforce: (path) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(PrivateFileAccessService, (access) => Effect.promise(() => access.enforce(path))).pipe(
          Effect.provide(PrivateFileAccessLive),
        ),
      ),
    ),
  verify: (path) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(PrivateFileAccessService, (access) => Effect.promise(() => access.verify(path))).pipe(
          Effect.provide(PrivateFileAccessLive),
        ),
      ),
    ),
};
