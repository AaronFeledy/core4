import { expect, test } from "bun:test";
import * as ConfigLayer from "@lando/engine/services/config";
import * as FileSystemLayer from "@lando/engine/services/file-system";
import { GlobalAppError, NotImplementedError } from "@lando/sdk/errors";
import { GlobalAppService, LandofileService } from "@lando/sdk/services";
import { Effect, Layer, Result } from "effect";
import { runAppConfig, runGlobalConfig } from "../../../src/cli/config-command-runtime.ts";
import { layerTransactionGuard, testStateStoreLayer } from "../../_support/landofile-layer.ts";

const dependencies = Layer.mergeAll(
  ConfigLayer.layer,
  FileSystemLayer.layer,
  testStateStoreLayer,
  layerTransactionGuard,
);

test("app command adapter preserves the embedding host's actual LandofileService", async () => {
  // Given a host-provided discovery service with a distinctive typed outcome.
  const error = new NotImplementedError({
    message: "Host discovery",
    commandId: "app:config",
    remediation: "Use host source.",
  });
  const service = LandofileService.of({ discover: Effect.fail(error) });
  // When the real command adapter chooses its default service wiring.
  const result = await Effect.runPromise(
    runAppConfig({ subcommand: "view" }).pipe(
      Effect.result,
      Effect.provideService(LandofileService, service),
      Effect.provide(dependencies),
    ),
  );
  // Then it calls the injected service instead of discovering through a replacement default.
  expect(result).toEqual(Result.fail(error));
});

test("global command adapter preserves the embedding host's actual GlobalAppService", async () => {
  // Given a host-provided paths operation with a distinctive typed outcome.
  const error = new GlobalAppError({
    message: "Host paths",
    operation: "paths",
    remediation: "Use host paths.",
  });
  const service = GlobalAppService.of({
    id: "global",
    root: Effect.die("Must use paths"),
    paths: Effect.fail(error),
    providerId: Effect.die("Must not choose provider"),
    ensureRoot: Effect.die("Must not create root"),
    ensureUserLandofile: Effect.die("Must not create file"),
    ensureRunning: () => Effect.die("Must not start services"),
    regenerateDist: () => Effect.die("Must not regenerate dist"),
  });
  // When a write resolves its target through the real command adapter.
  const result = await Effect.runPromise(
    runGlobalConfig({ subcommand: "set", key: "name", value: "global" }).pipe(
      Effect.result,
      Effect.provideService(GlobalAppService, service),
      Effect.provide(dependencies),
    ),
  );
  // Then the injected service remains authoritative.
  expect(result).toEqual(Result.fail(error));
});
