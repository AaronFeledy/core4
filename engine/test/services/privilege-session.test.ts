import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";
import { makePrivilegeService } from "../../src/services/privilege";
import * as BunProcessRunner from "../../src/services/process-runner";

describe.skipIf(process.platform !== "linux")("PrivilegeService with the real ProcessRunner", () => {
  test("sudo children share Lando's session and receive piped input, so one ticket serves the run", async () => {
    // Given a fake sudo that records its session id, its argv, and what it read on stdin.
    const dir = await mkdtemp(join(tmpdir(), "lando-fake-sudo-"));
    const log = join(dir, "log");
    const fakeSudo = join(dir, "sudo");
    await writeFile(
      fakeSudo,
      `#!/bin/sh\nin=""\nif [ "$1" = "-n" ] && [ "$2" = "--" ]; then in="$(cat)"; fi\nprintf '%s|%s|%s\\n' "$(ps -o sid= -p $$ | tr -d ' ')" "$*" "$in" >> '${log}'\n`,
    );
    await chmod(fakeSudo, 0o755);
    try {
      const runner = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* ProcessRunner;
        }).pipe(Effect.provide(BunProcessRunner.layer)),
      );
      const service = makePrivilegeService(runner, {
        host: {
          platform: "linux",
          euid: () => 1000,
          env: {},
          which: () => fakeSudo,
          isExecutableFile: () => false,
          hasTerminal: () => false,
        },
      });

      // When a session runs one command with input.
      await Effect.runPromise(
        Effect.scoped(
          service.openSession("install the drop-in").pipe(
            Effect.flatMap((session) =>
              session.elevate(["/usr/bin/tee", "/etc/x"], {
                stdin: new TextEncoder().encode("Delegate=yes"),
              }),
            ),
          ),
        ),
      );

      // Then every invocation ran in this process's session, the command read its input, and the
      // user's own ticket was not forgotten.
      const ownSid = Bun.spawnSync(["ps", "-o", "sid=", "-p", String(process.pid)])
        .stdout.toString()
        .trim();
      const lines = (await readFile(log, "utf8")).trim().split("\n");
      expect(lines).toEqual([
        `${ownSid}|-n -v|`,
        `${ownSid}|-n -v|`,
        `${ownSid}|-n -- /usr/bin/tee /etc/x|Delegate=yes`,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
