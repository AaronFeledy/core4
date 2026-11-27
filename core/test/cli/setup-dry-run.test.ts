import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigService,
  Downloader,
  InteractionService,
  PrivilegeService,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import { TestRuntimeProvider, makeTestDownloader, makeTestInteractionService } from "@lando/core/testing";
import { GlobalConfigSources } from "@lando/engine/services/config";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { layerWith as httpClientLayerWith } from "@lando/http-client/live";
import { makeLandoPaths } from "@lando/paths";
import { createStandaloneRedactor } from "@lando/redaction";
import { redactValueWithPolicy, structuralRedaction } from "@lando/sdk/command-result";
import { HostChangeConsentRequiredError } from "@lando/sdk/errors";
import { GlobalConfig, type HostChange, HostChangeId, ProviderId } from "@lando/sdk/schema";
import { isSecretFieldName } from "@lando/sdk/secrets";
import {
  CertificateAuthority,
  type HostChangeProposal,
  PathsService,
  type ProviderSetupOptions,
} from "@lando/sdk/services";
import {
  makeTestCertificateAuthority,
  makeTestPrivilegeService,
  makeTestRuntimeProviderRegistry,
} from "@lando/sdk/test";
import { Cause, Effect, Exit, Layer, Schema } from "effect";
import { SetupResultSchema, setupSpec } from "../../src/cli/command-specs/meta/setup.ts";

const change = (id: string, overrides: Partial<HostChange> = {}): HostChange => ({
  id: HostChangeId.make(`provider-lando:${id}`),
  owner: "@lando/provider-lando",
  stage: "provider",
  summary: `Apply ${id}`,
  reason: `The runtime needs ${id}.`,
  consent: "standard",
  persistent: false,
  requirement: "required",
  steps: [{ id: "run", summary: "run", argv: ["/usr/bin/true", id], privileged: true, when: "always" }],
  undo: { _tag: "none", detail: "Nothing to undo." },
  ...overrides,
});

/** A provider that plans a standard and a separately approved change and applies what it is handed. */
const fixture = () => {
  const counts = { setup: 0, opened: 0, elevated: 0, probes: 0, trusted: 0 };
  const proposals: ReadonlyArray<HostChangeProposal> = [
    {
      change: change("install-uidmap"),
      apply: (steps) => steps.run("run").pipe(Effect.as({ changed: true })),
    },
    {
      change: change("enable-linger", {
        consent: "separate",
        optInFlag: "enable-linger",
        persistent: true,
        requirement: "recommended",
      }),
      apply: (steps) => steps.run("run").pipe(Effect.as({ changed: true })),
    },
  ];
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    planHostChanges: () => Effect.succeed(proposals),
    setup: (options: ProviderSetupOptions) =>
      Effect.gen(function* () {
        counts.setup += 1;
        for (const { change: planned } of proposals) {
          if (options.hostChanges?.approved(planned.id) !== undefined)
            yield* options.hostChanges.apply(planned.id);
        }
      }),
  };
  const trust: HostChangeProposal = {
    change: change("trust-system-store", {
      id: HostChangeId.make("ca-mkcert:trust-system-store"),
      owner: "@lando/ca-mkcert",
      stage: "ca",
      requirement: "recommended",
    }),
    apply: (steps) => steps.run("run").pipe(Effect.as({ changed: true })),
  };
  const ca = CertificateAuthority.of({
    ...makeTestCertificateAuthority(),
    planHostChanges: Effect.succeed([trust]),
    setup: (options) =>
      Effect.gen(function* () {
        if (options.hostChanges?.approved(trust.change.id) !== undefined) {
          yield* options.hostChanges.apply(trust.change.id);
          counts.trusted += 1;
        }
        return { trustStores: [] };
      }),
  });
  const privilege = {
    ...makeTestPrivilegeService({
      elevate: () =>
        Effect.sync(() => {
          counts.elevated += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      open: () =>
        Effect.sync(() => {
          counts.opened += 1;
        }),
    }),
    credentialStatus: Effect.succeed({ state: "will-prompt" as const }),
  };
  const downloader = Effect.runSync(makeTestDownloader());
  const layers = (userDataRoot: string) =>
    Layer.mergeAll(
      Layer.succeed(GlobalConfigSources, { env: { ...process.env }, sources: { user: false, env: true } }),
      Layer.succeed(
        RuntimeProviderRegistry,
        makeTestRuntimeProviderRegistry({
          list: Effect.succeed([ProviderId.make("lando")]),
          capabilities: Effect.succeed(provider.capabilities),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.succeed(PathsService, makeLandoPaths()),
      BunFileSystem.layer,
      Layer.succeed(
        ConfigService,
        ConfigService.of({
          load: Effect.succeed(
            Schema.decodeUnknownSync(GlobalConfig)({ telemetry: { enabled: false }, userDataRoot }),
          ),
          get: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(Downloader, Downloader.of(downloader.service)),
      Layer.succeed(
        InteractionService,
        InteractionService.of(makeTestInteractionService({ answers: {} }).service),
      ),
      Layer.succeed(PrivilegeService, PrivilegeService.of(privilege)),
      Layer.succeed(CertificateAuthority, ca),
      httpClientLayerWith({
        fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
      }),
    );
  const run = async (flags: Readonly<Record<string, unknown>>) => {
    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-setup-dry-run-"));
    try {
      const exit = await Effect.runPromiseExit(
        setupSpec
          .run({
            installDir: "/opt/lando",
            flags: {
              "skip-proxy": true,
              "skip-install-ca": true,
              "skip-shell-integration": true,
              "skip-file-sync": true,
              ...flags,
            },
            _networkProbe: () =>
              Effect.sync(() => {
                counts.probes += 1;
              }),
          })
          .pipe(Effect.provide(layers(userDataRoot))),
      );
      return { exit, written: await readdir(userDataRoot) };
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
    }
  };
  return { counts, run };
};

const succeeded = <A>(exit: Exit.Exit<A, unknown>): A => {
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`setup failed: ${Cause.pretty(exit.cause)}`);
};

describe("lando setup --dry-run", () => {
  test("reports the plan and the credentials a run would need, and changes nothing", async () => {
    const { counts, run } = fixture();

    const { exit, written } = await run({ "dry-run": true });

    const result = succeeded(exit);
    if (!result.dryRun) throw new Error("expected a plan");
    expect(
      result.changes.map(({ change: planned, approval, approvedBy }) => [
        String(planned.id),
        approval,
        approvedBy,
      ]),
    ).toEqual([
      ["provider-lando:install-uidmap", "blocked", ["--yes"]],
      ["provider-lando:enable-linger", "will-skip", ["--enable-linger"]],
    ]);
    expect(result.elevation.state).toBe("will-prompt");
    expect(written).toEqual([]);
    expect(counts).toEqual({ setup: 0, opened: 0, elevated: 0, probes: 0, trusted: 0 });
  });

  test("lists trusting the local CA with the provider's changes and names no unpreviewed stage", async () => {
    const { run } = fixture();

    const result = succeeded((await run({ "dry-run": true, "skip-install-ca": false })).exit);

    if (!result.dryRun) throw new Error("expected a plan");
    expect(result.changes.map(({ change: planned }) => String(planned.id))).toEqual([
      "provider-lando:install-uidmap",
      "provider-lando:enable-linger",
      "ca-mkcert:trust-system-store",
    ]);
    expect(result.notices).toEqual(["The network trust probe was skipped."]);
  });

  test("previews the approvals that the same flags would reach in a real run", async () => {
    const { run } = fixture();

    const result = succeeded((await run({ "dry-run": true, yes: true, "enable-linger": true })).exit);

    expect(result.dryRun ? result.changes.map(({ approval }) => approval) : []).toEqual([
      "approved",
      "approved",
    ]);
  });
});

describe("lando setup host-change consent", () => {
  test("a run that cannot ask fails before credentials or provider setup, naming --yes", async () => {
    const { counts, run } = fixture();

    const { exit } = await run({ "no-interactive": true });

    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(HostChangeConsentRequiredError);
    expect(error instanceof HostChangeConsentRequiredError ? error.flags : []).toEqual(["--yes"]);
    expect([counts.opened, counts.setup, counts.elevated]).toEqual([0, 0, 0]);
  });

  test("--yes opens one session, applies the standard change, and reports every planned change", async () => {
    const { counts, run } = fixture();

    const result = succeeded((await run({ yes: true, "no-interactive": true })).exit);

    expect(
      result.dryRun ? [] : result.hostChanges.map(({ id, outcome }) => ({ id: String(id), outcome })),
    ).toEqual([
      { id: "provider-lando:install-uidmap", outcome: "applied" },
      { id: "provider-lando:enable-linger", outcome: "declined" },
    ]);
    expect([counts.opened, counts.setup, counts.elevated]).toEqual([1, 1, 1]);
  });

  test("one consent and one session cover trusting the local CA with the provider's changes", async () => {
    const { counts, run } = fixture();

    const result = succeeded(
      (await run({ yes: true, "no-interactive": true, "skip-install-ca": false })).exit,
    );

    expect(
      result.dryRun ? [] : result.hostChanges.map(({ id, outcome }) => [String(id), outcome]),
    ).toContainEqual(["ca-mkcert:trust-system-store", "applied"]);
    expect([counts.opened, counts.elevated, counts.trusted]).toEqual([1, 2, 1]);
  });

  test("a run that cannot ask skips trusting the local CA instead of failing", async () => {
    const { counts, run } = fixture();

    const result = succeeded(
      (await run({ "no-interactive": true, "skip-install-ca": false, "skip-provider": true })).exit,
    );

    expect(result.dryRun ? [] : result.hostChanges.map(({ id, outcome }) => [String(id), outcome])).toEqual([
      ["ca-mkcert:trust-system-store", "declined"],
    ]);
    expect([counts.opened, counts.elevated, counts.trusted]).toEqual([0, 0, 0]);
  });
});

describe("lando setup --dry-run machine output", () => {
  test("keeps how a run would get administrator access readable after secret-name redaction", () => {
    const redactor = createStandaloneRedactor("secrets");
    const elevation = { state: "required", detail: "Run `sudo -v` in this terminal first." } as const;
    const plan = {
      dryRun: true,
      providerId: "lando",
      selectionSource: "default",
      elevation,
      changes: [],
      notices: [],
    } as const;

    const redacted = redactValueWithPolicy(redactor, structuralRedaction(SetupResultSchema), plan);

    expect(Reflect.get(Object(redacted), "elevation")).toEqual(elevation);
    // The reason for the name: any key that contains `credential` is masked whole.
    expect(isSecretFieldName("credentials")).toBe(true);
    expect(isSecretFieldName("elevation")).toBe(false);
  });
});
