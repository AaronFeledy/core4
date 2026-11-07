import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRuntimeProvider, makeTestDownloader, makeTestInteractionService } from "@lando/core/testing";
import { GlobalConfigSources } from "@lando/engine/services/config";
import { layerWith } from "@lando/http-client/live";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { GlobalConfig, ProviderId } from "@lando/sdk/schema";
import {
  CertificateAuthority,
  ConfigService,
  Downloader,
  InteractionService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { makeTestCertificateAuthority } from "@lando/sdk/test";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { setupSpec } from "../../src/cli/command-specs/meta/setup";
import { readSetupReadiness, writeSetupReadiness } from "../../src/cli/commands/setup-readiness";

test.each(["provider", "ca", "selection-failure", "selection-defect"] as const)(
  "setup readiness reflects an exit at %s",
  async (stopAt) => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-readiness-interrupt-"));
    const config = Schema.decodeUnknownSync(GlobalConfig)({ userDataRoot, defaultProviderId: "podman" });
    const downloader = Effect.runSync(makeTestDownloader());
    const provider = {
      ...TestRuntimeProvider,
      id: "podman",
      isAvailable: Effect.succeed(true),
      setup: () => (stopAt === "provider" ? Effect.interrupt : Effect.void),
    };
    const select = () => {
      switch (stopAt) {
        case "selection-failure":
          return Effect.fail(
            new ProviderUnavailableError({
              providerId: "podman",
              operation: "select",
              message: "selection failed",
              remediation: "Install Podman, then rerun lando setup --provider=podman.",
            }),
          );
        case "selection-defect":
          return Effect.die(new Error("selection defect"));
        case "provider":
        case "ca":
          return Effect.succeed(provider);
      }
    };
    const layers = Layer.mergeAll(
      Layer.succeed(ConfigService, {
        load: Effect.succeed(config),
        get: (key) => Effect.succeed(config[key]),
      }),
      Layer.succeed(GlobalConfigSources, { env: {}, sources: { user: false, env: false } }),
      Layer.succeed(RuntimeProviderRegistry, {
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        appliedPlansFor: () => Effect.succeed([]),
        list: Effect.succeed([ProviderId.make("podman")]),
        capabilities: Effect.succeed(provider.capabilities),
        select,
      }),
      Layer.succeed(CertificateAuthority, {
        ...makeTestCertificateAuthority(),
        setup: () => Effect.interrupt,
      }),
      Layer.succeed(Downloader, downloader.service),
      Layer.succeed(InteractionService, makeTestInteractionService().service),
      layerWith({
        fetch: Object.assign(() => Promise.reject(new Error("Network access is forbidden in this test")), {
          preconnect: () => undefined,
        }),
      }),
    );
    try {
      await Effect.runPromise(
        writeSetupReadiness(userDataRoot, "podman", {
          status: "ready",
          steps: [{ id: "old-run", status: "satisfied", evidence: "previous run" }],
        }),
      );
      const exit = await Effect.runPromiseExit(
        setupSpec
          .run({ flags: { provider: "podman", yes: true, "no-interactive": true } })
          .pipe(Effect.provide(layers)),
      );

      const interrupted = stopAt === "provider" || stopAt === "ca";
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(interrupted);
      const summary = await Effect.runPromise(readSetupReadiness(userDataRoot));
      expect(summary?.steps).toEqual(
        stopAt === "ca"
          ? [{ id: "provider", status: "satisfied", evidence: "Provider podman setup completed." }]
          : [],
      );
      expect(summary?.status).toBe(interrupted ? "in-progress" : "failed");
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  },
);
