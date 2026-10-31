import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { createBufferedRendererIO } from "@lando/renderer/io";
import type { StopAppResult } from "@lando/sdk/app";
import {
  AppId,
  type DestroyAppResult,
  ProviderId,
  ServiceName,
  type ServiceShutdownObservation,
  StopAppResult as StopAppResultSchema,
} from "@lando/sdk/schema";

import { renderDestroyAppResult } from "../../src/cli/commands/destroy.ts";
import {
  GlobalDestroyResultSchema,
  renderGlobalDestroyResult,
} from "../../src/cli/commands/meta/global-destroy.ts";
import { GlobalStopResultSchema, renderGlobalStopResult } from "../../src/cli/commands/meta/global-stop.ts";
import {
  publishShutdownWarnings,
  receiptShutdownObservations,
  shutdownDetailText,
  shutdownWarnings,
} from "../../src/cli/commands/shutdown-summary.ts";
import { renderStopAppResult } from "../../src/cli/commands/stop.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const shop = AppId.make("shop");
const lando = ProviderId.make("lando");

const exited = (
  service: string,
  exitCode: number | undefined,
  extra: { readonly appId?: AppId; readonly oomKilled?: boolean; readonly containerId?: string } = {},
): ServiceShutdownObservation => ({
  appId: extra.appId ?? shop,
  providerId: lando,
  service: ServiceName.make(service),
  status: "exited",
  ...(exitCode === undefined ? {} : { exitCode }),
  ...(extra.oomKilled === undefined ? {} : { oomKilled: extra.oomKilled }),
  ...(extra.containerId === undefined ? {} : { containerId: extra.containerId }),
});

const unknown = (
  service: string,
  reason: "container-absent" | "state-unavailable" | "not-exited",
  appId: AppId = shop,
): ServiceShutdownObservation => ({
  appId,
  providerId: lando,
  service: ServiceName.make(service),
  status: "unknown",
  reason,
});

const inspectFailed = (
  service: string,
  message: string,
  remediation: string,
): ServiceShutdownObservation => ({
  appId: shop,
  providerId: lando,
  service: ServiceName.make(service),
  status: "unknown",
  reason: "inspect-failed",
  diagnostic: { _tag: "ProviderRequestError", message, remediation },
});

const stopped = (
  servicesStopped: ReadonlyArray<string>,
  shutdownObservations?: ReadonlyArray<ServiceShutdownObservation>,
): StopAppResult => ({
  app: "shop",
  outcome: "stopped",
  servicesStopped,
  ...(shutdownObservations === undefined ? {} : { shutdownObservations }),
});

const VERDICT_WORDS = /graceful|forced|force-kill|clean/iu;

describe("shutdown detail text", () => {
  test.each([
    [0, "exit 0"],
    [143, "exit 143"],
    [137, "exit 137"],
  ])("repeats exit code %d as a fact without a verdict", (exitCode, text) => {
    const detail = shutdownDetailText(exited("web", exitCode));
    expect(detail).toBe(text);
    expect(detail).not.toMatch(VERDICT_WORDS);
  });

  test("an exited container without a daemon exit code is not reported as zero", () => {
    expect(shutdownDetailText(exited("web", undefined))).toBe("exit code unknown");
  });

  test.each([
    ["container-absent", "container absent"],
    ["state-unavailable", "state unavailable"],
    ["not-exited", "not exited"],
  ] as const)("names the unknown reason %s plainly", (reason, text) => {
    expect(shutdownDetailText(unknown("web", reason))).toBe(text);
  });

  test("appends the OOMKilled bit only when the runtime explicitly reported it", () => {
    expect(shutdownDetailText(exited("web", 137, { oomKilled: true }))).toBe("exit 137, OOMKilled");
    expect(shutdownDetailText(exited("web", 137, { oomKilled: false }))).toBe("exit 137");
    expect(shutdownDetailText(exited("web", 137))).toBe("exit 137");
  });

  test("keeps a reported OOMKilled bit even when the exit state is incomplete", () => {
    expect(shutdownDetailText({ ...unknown("web", "not-exited"), oomKilled: true })).toBe(
      "not exited, OOMKilled",
    );
  });
});

describe("stop summary line", () => {
  test("keeps the legacy line when the provider contributed no observations", () => {
    expect(renderStopAppResult(stopped(["database", "web"]))).toBe("stopped: shop - database, web");
    expect(renderStopAppResult(stopped(["database", "web"], []))).toBe("stopped: shop - database, web");
    expect(renderStopAppResult({ app: "shop", outcome: "unchanged", servicesStopped: [] })).toBe(
      "unchanged: shop - no services",
    );
  });

  test("follows each stopped service with its observed exit code in the original order", () => {
    const line = renderStopAppResult(
      stopped(
        ["database", "web", "worker"],
        [exited("worker", 137), exited("web", 143), exited("database", 0)],
      ),
    );
    expect(line).toBe("stopped: shop - database (exit 0), web (exit 143), worker (exit 137)");
    expect(line).not.toMatch(VERDICT_WORDS);
  });

  test("leaves a service bare when only its siblings were observed", () => {
    expect(renderStopAppResult(stopped(["database", "web"], [exited("web", 143)]))).toBe(
      "stopped: shop - database, web (exit 143)",
    );
  });

  test("states unknown exit facts inline without raising them to warnings", () => {
    const observations = [
      unknown("database", "container-absent"),
      unknown("cache", "state-unavailable"),
      unknown("web", "not-exited"),
    ];
    expect(renderStopAppResult(stopped(["database", "cache", "web"], observations))).toBe(
      "stopped: shop - database (container absent), cache (state unavailable), web (not exited)",
    );
    expect(shutdownWarnings(observations)).toEqual([]);
  });

  test("renders a long service name in full", () => {
    const name = "a-very-long-service-name-that-nobody-should-truncate-because-it-identifies-the-container";
    expect(renderStopAppResult(stopped([name], [exited(name, 0)]))).toBe(`stopped: shop - ${name} (exit 0)`);
  });

  test("attributes a repeated service name to each app identity instead of pairing by position", () => {
    const oldShop = AppId.make("old-shop");
    const line = renderStopAppResult(
      stopped(
        ["web", "db", "web"],
        [unknown("web", "container-absent", oldShop), exited("web", 0), exited("db", 0)],
      ),
    );
    expect(line).toBe("stopped: shop - web (old-shop: container absent; shop: exit 0), db (shop: exit 0)");
  });

  test("keeps observations that match no stopped service out of the line", () => {
    expect(
      renderStopAppResult(stopped(["web"], [exited("web", 143), unknown("ghost", "container-absent")])),
    ).toBe("stopped: shop - web (exit 143)");
  });
});

describe("destroy and global summary lines", () => {
  test("keeps the volumes trailer after the observed services", () => {
    const result: DestroyAppResult = {
      app: "shop",
      outcome: "destroyed",
      servicesDestroyed: ["database", "web"],
      volumesRemoved: false,
      snapshotsRemoved: 0,
      shutdownObservations: [exited("database", 0), exited("web", 143)],
    };
    expect(renderDestroyAppResult(result)).toBe(
      "destroyed: shop - database (exit 0), web (exit 143) (volumes preserved)",
    );
    const { shutdownObservations: _observed, ...unobserved } = result;
    expect(renderDestroyAppResult(unobserved)).toBe("destroyed: shop - database, web (volumes preserved)");
  });

  test("global wrappers decode and render the canonical observations field", () => {
    const observation = exited("ssh-agent", 0, { appId: AppId.make("global") });
    const stop = Schema.decodeUnknownSync(GlobalStopResultSchema)({
      app: "global",
      outcome: "stopped",
      materialized: true,
      servicesStopped: ["ssh-agent"],
      shutdownObservations: [observation],
    });
    expect(renderGlobalStopResult(stop)).toBe("stopped: global - ssh-agent (exit 0)");
    const destroy = Schema.decodeUnknownSync(GlobalDestroyResultSchema)({
      app: "global",
      outcome: "destroyed",
      materialized: true,
      servicesDestroyed: ["ssh-agent"],
      volumesRemoved: true,
      shutdownObservations: [{ ...observation, exitCode: 143 }],
    });
    expect(renderGlobalDestroyResult(destroy)).toBe(
      "destroyed: global - ssh-agent (exit 143) (volumes removed)",
    );
    expect(GlobalStopResultSchema.fields.shutdownObservations).toBe(
      StopAppResultSchema.fields.shutdownObservations,
    );
  });

  test("forwards a receipt's observations and omits the field when the provider did not observe", () => {
    expect(receiptShutdownObservations({ services: ["ssh-agent"] })).toEqual({});
    const observations = [exited("ssh-agent", 0)];
    expect(
      receiptShutdownObservations({ services: ["ssh-agent"], shutdownObservations: observations }),
    ).toEqual({
      shutdownObservations: observations,
    });
  });
});

describe("shutdown warnings", () => {
  test("warns on an explicit OOMKilled report with the runtime as the source", () => {
    expect(shutdownWarnings([exited("worker", 137, { oomKilled: true })])).toEqual([
      "worker: runtime reported OOMKilled (exit 137).",
    ]);
  });

  test("does not warn on a bare non-zero exit, an absent OOM bit, or OOMKilled false", () => {
    expect(
      shutdownWarnings([
        exited("worker", 137),
        exited("web", 137, { oomKilled: false }),
        exited("db", 143),
        unknown("cache", "container-absent"),
      ]),
    ).toEqual([]);
    expect(shutdownWarnings(undefined)).toEqual([]);
  });

  test("warns on an inspection failure with the sanitized diagnostic and escaped control bytes", () => {
    const warnings = shutdownWarnings([
      inspectFailed("web", "Container inspect timed out\u001b[31m.", "Retry once the runtime answers."),
    ]);
    expect(warnings).toEqual([
      "web: shutdown state could not be inspected (ProviderRequestError): Container inspect timed out\\u001b[31m. Retry once the runtime answers.",
    ]);
    expect(warnings[0]).not.toContain("\u001b");
  });

  test("attributes warnings by app only when observations span several apps", () => {
    const oldShop = AppId.make("old-shop");
    expect(
      shutdownWarnings([exited("web", 137, { oomKilled: true, appId: oldShop }), exited("web", 0)]),
    ).toEqual(["web (old-shop): runtime reported OOMKilled (exit 137)."]);
  });
});

const runStop = async (
  result: StopAppResult,
  format: "text" | "json" | "yaml",
  rendererMode: "plain" | "lando" = "plain",
) => {
  const io = createBufferedRendererIO();
  const codes: number[] = [];
  await runWithRendererHandling(Effect.succeed(result).pipe(Effect.tap(publishShutdownWarnings)), {
    runtime: Layer.empty,
    rendererMode,
    resultFormat: format,
    command: "app:stop",
    resultSchema: StopAppResultSchema,
    io,
    sourceEnv: {},
    render: (value) => renderStopAppResult(value),
    setExitCode: (code) => {
      codes.push(code);
    },
    formatError: () => "must not render",
  });
  return { stdout: io.stdout(), stderr: io.stderr(), codes };
};

describe("renderer boundary", () => {
  const oom = stopped(
    ["database", "worker"],
    [exited("database", 0), exited("worker", 137, { oomKilled: true })],
  );
  const benign = stopped(["database", "web"], [exited("database", 0), exited("web", 143)]);

  test("text output puts the summary on stdout and the OOM warning on stderr", async () => {
    const { stdout, stderr } = await runStop(oom, "text");
    expect(stdout).toBe("stopped: shop - database (exit 0), worker (exit 137, OOMKilled)\n");
    expect(stderr).toContain("⚠ worker: runtime reported OOMKilled (exit 137).");
    expect(stderr).not.toContain("stopped:");
  });

  test("text output stays quiet on stderr for a benign TERM exit", async () => {
    const { stdout, stderr } = await runStop(benign, "text");
    expect(stdout).toBe("stopped: shop - database (exit 0), web (exit 143)\n");
    expect(stderr).toBe("");
  });

  test("the default renderer keeps the same single line off a TTY", async () => {
    const { stdout } = await runStop(benign, "text", "lando");
    expect(stdout).toBe("stopped: shop - database (exit 0), web (exit 143)\n");
  });

  test("json output carries every observation through the canonical schema and the warning in the envelope", async () => {
    const { stdout, stderr } = await runStop(oom, "json");
    const envelope = JSON.parse(stdout);
    expect(envelope).toMatchObject({
      ok: true,
      command: "app:stop",
      result: {
        app: "shop",
        servicesStopped: ["database", "worker"],
        shutdownObservations: [
          { appId: "shop", providerId: "lando", service: "database", status: "exited", exitCode: 0 },
          {
            appId: "shop",
            providerId: "lando",
            service: "worker",
            status: "exited",
            exitCode: 137,
            oomKilled: true,
          },
        ],
      },
      warnings: [{ code: "LANDO_MESSAGE_WARN", message: "worker: runtime reported OOMKilled (exit 137)." }],
    });
    expect(Schema.decodeUnknownSync(StopAppResultSchema)(envelope.result)).toEqual(oom);
    expect(stderr).toBe("");
  });

  test("json output has no warning for a benign exit and keeps unknown facts in the result", async () => {
    const result = stopped(["web"], [unknown("web", "container-absent")]);
    const { stdout } = await runStop(result, "json");
    const envelope = JSON.parse(stdout);
    expect(envelope.warnings).toEqual([]);
    expect(envelope.result.shutdownObservations).toEqual([
      { appId: "shop", providerId: "lando", service: "web", status: "unknown", reason: "container-absent" },
    ]);
  });

  test("yaml output encodes the observations with the same schema", async () => {
    const { stdout } = await runStop(benign, "yaml");
    expect(stdout).toContain("shutdownObservations:");
    expect(stdout).toContain("exitCode: 143");
    expect(stdout).not.toContain("stopped: shop -");
  });
});
