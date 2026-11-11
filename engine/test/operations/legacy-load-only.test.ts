import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { AppPlanner, LandofileService } from "@lando/sdk/services";
import { Effect } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { current, fixture } from "./legacy-teardown-support.ts";

test.each(["stop", "destroy"] as const)(
  "%s reconciles loaded legacy names even when desired planning fails",
  async (command) => {
    for (const name of [current.name, "third-name"]) {
      const root = AbsolutePath.make(mkdtempSync(join(tmpdir(), "lando-legacy-load-")));
      const harness = fixture(root);
      const file = join(root, ".lando.yml");
      await Bun.write(file, `name: ${name}\nservices: {}\n`);
      const failure = new LandofileValidationError({
        file,
        message: "Desired composition cannot be planned",
        remediation: "Fix the service type.",
        issues: [{ path: ["services"], message: "Unsupported service type" }],
      });
      try {
        const result = await Effect.runPromise(
          withResolvedCwd(
            root,
            Effect.gen(function* () {
              if (command === "stop") return yield* stopApp();
              return yield* destroyApp({ yes: true });
            }),
          ).pipe(
            Effect.provideService(LandofileService, {
              discover: Effect.succeed(literalTestLandofile({ name, services: {} }, root)),
            }),
            Effect.provideService(AppPlanner, {
              plan: () => Effect.fail(failure),
            }),
            Effect.provide(harness.layer),
          ),
        );
        expect(result.outcome).toBe(command === "stop" ? "stopped" : "destroyed");
        expect([...harness.containers]).toEqual([]);
        expect(harness.applied.map((plan) => plan.id)).toEqual(
          command === "stop" && name === current.name ? [current.id] : [],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(harness.userDataRoot, { recursive: true, force: true });
      }
    }
  },
);
