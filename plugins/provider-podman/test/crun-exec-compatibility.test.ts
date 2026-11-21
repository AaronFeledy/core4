import { describe, expect, test } from "bun:test";
import {
  CRUN_OOM_SCORE_ADJ_ISSUE_URL,
  CRUN_OOM_SCORE_ADJ_REMEDIATION,
} from "@lando/container-runtime/podman/oci-runtime-floor";
import { layer as makeProviderLayer } from "@lando/provider-podman";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { EventService, RuntimeProvider } from "@lando/sdk/services";
import { DateTime, Effect, Exit, Stream } from "effect";

import { CRUN_ROOTLESS_EXEC_CHECK_ID, makeCrunRootlessExecCheck } from "../src/crun-exec-compatibility.ts";
import { withPing } from "./podman-api-fixtures.ts";

const CRUN_1_31_BANNER = `crun version 1.31
commit: 0e849780ccb4da009a6241f28d71be20957ba56d
spec: 1.0.0
+SYSTEMD +SELINUX
`;

const badInfo = {
  version: { Version: "6.1.3" },
  host: {
    arch: "amd64",
    security: { rootless: true },
    ociRuntime: { name: "crun", version: CRUN_1_31_BANNER },
  },
};

const safeInfo = {
  version: { Version: "6.1.3" },
  host: {
    arch: "amd64",
    security: { rootless: true },
    ociRuntime: { name: "crun", version: "crun version 1.28\ncommit: abc\n" },
  },
};

const doctorInput = {
  providerId: "podman",
  platform: "linux" as const,
  env: {},
  userDataRoot: undefined,
  binDir: undefined,
  stateDir: undefined,
};

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-11-21T00:00:00Z"),
  source: "provider-podman/crun-exec-compatibility.test.ts",
  runtime: 4 as const,
};

const appId = AppId.make("crun-warn-app");
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("podman");

const plan: AppPlan = {
  id: appId,
  name: "Crun Warn App",
  slug: "crun-warn-app",
  root: AbsolutePath.make("/tmp/crun-warn-app"),
  provider: providerId,
  services: {
    [serviceName]: {
      name: serviceName,
      type: "compose",
      provider: providerId,
      primary: true,
      artifact: { kind: "ref", ref: "busybox:1.37" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const recordingEvents = () => {
  const published: unknown[] = [];
  return {
    published,
    eventService: EventService.of({
      publish: (event) =>
        Effect.sync(() => {
          published.push(event);
        }),
      subscribe: () => Stream.empty,
      subscribeQueue: Effect.die("unused"),
      waitFor: () => Effect.never,
      subscribeWithHistory: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    }),
  };
};

describe("crun rootless exec doctor check", () => {
  test("warns for rootless system Podman in the broken range", async () => {
    const check = makeCrunRootlessExecCheck({
      readInfo: () => Effect.succeed(badInfo),
    });

    const reports = await Effect.runPromise(check.run(doctorInput));

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      name: CRUN_ROOTLESS_EXEC_CHECK_ID,
      status: "warn",
      severity: "warn",
      context: {
        providerId: "podman",
        ociRuntime: "crun",
        ociRuntimeVersion: "1.31",
        podmanVersion: "6.1.3",
        issue: CRUN_OOM_SCORE_ADJ_ISSUE_URL,
      },
    });
    expect(reports[0]?.runtimeStatus).toContain("lando setup");
    expect(reports[0]?.solutions[0]?.description).toBe(CRUN_OOM_SCORE_ADJ_REMEDIATION);
    expect(reports[0]?.preempts).toBeUndefined();
  });

  test("does not warn for the managed provider id", async () => {
    const check = makeCrunRootlessExecCheck({
      readInfo: () => Effect.succeed(badInfo),
    });

    expect(await Effect.runPromise(check.run({ ...doctorInput, providerId: "lando" }))).toEqual([]);
  });

  test("does not warn for rootful Podman, a missing field, or garbage", async () => {
    const cases = [
      {
        ...badInfo,
        host: { ...badInfo.host, security: { rootless: false } },
      },
      { version: { Version: "6.1.3" }, host: { security: { rootless: true } } },
      {
        ...badInfo,
        host: { ...badInfo.host, ociRuntime: { name: "crun", version: "not a banner" } },
      },
    ];
    for (const info of cases) {
      const check = makeCrunRootlessExecCheck({ readInfo: () => Effect.succeed(info) });
      expect(await Effect.runPromise(check.run(doctorInput))).toEqual([]);
    }
  });

  test("does not warn when info is unreadable", async () => {
    const check = makeCrunRootlessExecCheck({
      readInfo: () => Effect.fail(new Error("socket missing")),
    });

    expect(await Effect.runPromise(check.run(doctorInput))).toEqual([]);
  });

  test("does not warn for a safe crun pin", async () => {
    const check = makeCrunRootlessExecCheck({
      readInfo: () => Effect.succeed(safeInfo),
    });

    expect(await Effect.runPromise(check.run(doctorInput))).toEqual([]);
  });
});

describe("crun rootless exec start preflight", () => {
  test("warns on apply without refusing the provider", async () => {
    const { published, eventService } = recordingEvents();
    const exit = await Effect.runPromiseExit(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            eventService,
            podmanApi: withPing({
              info: Effect.succeed(badInfo),
              request: () => Effect.succeed({ status: 500, body: "unused" }),
            }),
          }),
        ),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;

    const applyExit = await Effect.runPromiseExit(
      Effect.scoped(exit.value.apply(plan, { reconcile: false })),
    );
    expect(Exit.isFailure(applyExit)).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      _tag: "message.warn",
    });
    const warning = published[0] as { readonly body: string };
    expect(warning.body).toContain("1.31");
    expect(warning.body).toContain("6.1.3");
    expect(warning.body).toContain("lando setup");
  });

  test("does not warn on apply for a safe crun pin", async () => {
    const { published, eventService } = recordingEvents();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            platform: "linux",
            eventService,
            podmanApi: withPing({
              info: Effect.succeed(safeInfo),
              request: () => Effect.succeed({ status: 500, body: "unused" }),
            }),
          }),
        ),
      ),
    );

    await Effect.runPromiseExit(Effect.scoped(provider.apply(plan, { reconcile: false })));
    expect(published).toEqual([]);
  });
});
