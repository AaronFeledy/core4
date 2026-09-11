import { Effect } from "effect";
import { type PrivateFileAccessProcessRunner, makeOwnerOnlyFileAccess } from "../src/private-file-access.ts";

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

export const ownerOnlyFileAccess = makeOwnerOnlyFileAccess({ processRunner: nativeProcessRunner });
