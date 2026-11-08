import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, GlobalConfig, appIdentityKey } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { withResolvedCwd } from "../../src/landofile/app-resolution.ts";
import { infoApp } from "../../src/operations/info.ts";
import { current, fixture, stale, target } from "./legacy-teardown-support.ts";

const config = Schema.decodeUnknownSync(GlobalConfig)({});
const configService = ConfigService.of({
  load: Effect.succeed(config),
  get: (key) => Effect.succeed(config[key]),
});

test.each(["handle", "cwd"] as const)(
  "info selects the named realization without mutation through %s",
  async (entry) => {
    const root = AbsolutePath.make(mkdtempSync(join(tmpdir(), "lando-legacy-info-")));
    const harness = fixture(root);
    await Bun.write(join(root, ".lando.yml"), `name: ${current.name}\nservices: {}\n`);
    const requested = {
      plan: { ...current, root, identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) } },
      root,
      app: { ...target.app, root },
    };
    try {
      const result = await Effect.runPromise(
        withResolvedCwd(root, infoApp({}, entry === "handle" ? requested : undefined)).pipe(
          Effect.provideService(ConfigService, configService),
          Effect.provide(harness.layer),
        ),
      );
      expect(result.app).toBe(current.name);
      expect(harness.applied.map((plan) => plan.id)).toEqual([stale.id, current.id]);
      expect([...harness.containers]).toEqual([stale.id, current.id]);
      expect([...harness.volumes]).toEqual([stale.id, current.id]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);

test("info refuses legacy state when neither name matches the requested app", async () => {
  const harness = fixture();
  const desired = { ...current, id: AppId.make("third-name"), name: "third-name", slug: "third-name" };
  const requested = { ...target, plan: desired, app: { ...target.app, id: desired.id } };
  try {
    const result = await Effect.runPromise(
      infoApp({}, requested).pipe(
        Effect.provideService(ConfigService, configService),
        Effect.provide(harness.layer),
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AppResolveError", reason: "ambiguous", detail: "applied-state" },
    });
    expect(harness.applied.map((plan) => plan.id)).toEqual([stale.id, current.id]);
    expect([...harness.containers]).toEqual([stale.id, current.id]);
  } finally {
    rmSync(harness.userDataRoot, { recursive: true, force: true });
  }
});
