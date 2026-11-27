import { expect, test } from "bun:test";
import { join } from "node:path";
import { ScenarioContextFactory } from "@lando/core/testing";
import { InfoAppResult } from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import { isScannerLiveEligible } from "./scanner-live-fixture.ts";

const decodeInfo = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), result: InfoAppResult })),
);
const decodeWarning = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.Literal("event"),
      event: Schema.Literal("message.warn"),
      payload: Schema.Struct({ body: Schema.String }),
    }),
  ),
);
const decodeReattachment = Schema.decodeUnknownSync(
  Schema.Struct({
    storage: Schema.Tuple([Schema.Struct({ store: Schema.String, target: Schema.String })]),
  }),
);

test.skipIf(process.platform !== "linux" || !isScannerLiveEligible())(
  "applying the nginx command default detaches the old root home and the warning can recover it",
  async () =>
    Effect.runPromise(
      ScenarioContextFactory.e2e(
        { guideId: "home-and-host", scenarioId: "nginx-root-home-upgrade", render: false },
        (context) =>
          Effect.gen(function* () {
            const name = `nginx-home-${crypto.randomUUID().slice(0, 12)}`;
            const marker = "retained nginx root home\nsecond line\n";
            const path = "/root/.lando-home-proof";
            const run = (argv: readonly string[], timeoutMs = 30_000) =>
              context.runCli(argv, { timeoutMs }).pipe(
                Effect.map((result) => {
                  expect(result.exitCode, `${argv.join(" ")}\n${result.stdout}\n${result.stderr}`).toBe(0);
                  return result.stdout;
                }),
              );
            const info = run(["info", "--format=json"]).pipe(
              Effect.map((stdout) =>
                decodeInfo(stdout).result.services.find(({ service }) => service === "web"),
              ),
            );
            const start = run(["start", "--format=json"], 120_000);

            // Opting out creates the real old launch shape without installing an older binary.
            yield* Effect.promise(() =>
              Bun.write(
                join(context.testDir, ".lando.yml"),
                `name: ${name}
runtime: 4
provider: lando
router:
  enabled: false
services:
  web:
    type: nginx
    projectUser: false
`,
              ),
            );
            yield* Effect.addFinalizer(() =>
              run(["destroy", "-y", "--volumes", "--format=json"]).pipe(Effect.asVoid, Effect.orDie),
            );
            yield* start;
            const oldHome = (yield* info)?.home;
            if (oldHome?.state !== "persisted") throw new Error(`No persisted home for ${name}`);
            expect(oldHome.target).toBe("/root");
            yield* run(["exec", "web", "--", "sh", "-c", `printf '%s' "$1" > ${path}`, "sh", marker]);

            // Editing the desired plan must not change exec or info until start applies it.
            yield* run(["app:config:unset", "services.web.projectUser"]);
            expect((yield* info)?.projectUser).toBeUndefined();
            expect(yield* run(["exec", "web", "--", "sh", "-c", `id -un && cat ${path}`])).toBe(
              `root\n${marker}`,
            );

            const applied = yield* start;
            expect((yield* info)?.projectUser?.name).toBe("nginx");
            expect(yield* run(["exec", "web", "--", "id", "-un"])).toBe("nginx\n");
            yield* run([
              "exec",
              "web",
              "--user",
              "root",
              "--",
              "sh",
              "-c",
              `test "$(id -un)" = root && test ! -e ${path}`,
            ]);

            // Reuse the coordinates the CLI actually advises, not the store from pre-upgrade info.
            const suggestions = applied.split("\n").flatMap((line) => {
              const warning = decodeWarning(line);
              if (Option.isNone(warning)) return [];
              const snippet = /storage:\s*\[\s*\{[^}\n]+\}\s*\]/u.exec(warning.value.payload.body)?.[0];
              return snippet === undefined ? [] : [decodeReattachment(Bun.YAML.parse(snippet))];
            });
            expect(suggestions).toEqual([{ storage: [{ store: oldHome.store, target: "/root" }] }]);
            for (const { storage } of suggestions) {
              yield* run([
                "app:config:set",
                "services.web.storage",
                JSON.stringify(storage),
                "--type",
                "json",
              ]);
            }
            yield* start;
            expect(yield* run(["exec", "web", "--user", "root", "--", "cat", path])).toBe(marker);
          }),
      ),
    ),
  720_000,
);
