import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";
import { EventService, ProcessRunner } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import { openHostTarget } from "../../../src/services/host-opener.ts";
import * as BunProcessRunner from "../../../src/services/process-runner.ts";

test.skipIf(process.platform === "win32")(
  "redacts unregistered opener targets from real process events without retaining targets globally",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hostopen-process-"));
    const script = join(root, "opener");
    const target = "https://alice:private-password@private-host.invalid/private/path?token=private-token";
    const events: Array<{ readonly _tag: string }> = [];
    try {
      await writeFile(script, '#!/bin/sh\nprintf "%s" "$1"\n', { mode: 0o755 });
      const services = Layer.mergeAll(
        BunProcessRunner.layer,
        Layer.succeed(
          EventService,
          EventService.of({
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            subscribe: () => Stream.die("unused"),
            subscribeQueue: Effect.die("unused"),
            waitFor: () => Effect.die("unused"),
            waitForAny: () => Effect.die("unused"),
            query: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(
          RedactionService,
          RedactionService.of({
            registerValues: registerRedactionValues,
            payloadValues: () => Effect.succeed(() => []),
            forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
          }),
        ),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const runner = yield* ProcessRunner;
          yield* openHostTarget(target).pipe(
            Effect.provideService(ProcessRunner, {
              ...runner,
              run: (input) => runner.run({ ...input, cmd: script }),
            }),
          );
          const redactor = yield* (yield* RedactionService).forProfile("secrets");
          expect(redactor.redactString("private-host.invalid/private/path")).toBe(
            "private-host.invalid/private/path",
          );
        }).pipe(Effect.provide(services)),
      );
      expect(events.map((event) => event._tag)).toEqual(["pre-process-exec", "post-process-exec"]);
      expect(JSON.stringify(events)).not.toContain("private-host.invalid");
      expect(JSON.stringify(events)).not.toContain("private-password");
      expect(events).toEqual([
        expect.objectContaining({ args: ["[redacted]"] }),
        expect.objectContaining({ args: ["[redacted]"], stdout: "[redacted]" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
