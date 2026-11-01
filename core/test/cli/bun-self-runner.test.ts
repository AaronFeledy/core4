import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BunProcessRunner from "@lando/engine/services/process-runner";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import {
  BunSelfReentryError,
  FileIoError,
  PluginPackageOperationError,
  ProcessExecError,
} from "@lando/sdk/errors";
import { EventService, type LandoEvent, ProcessRunner, type ProcessSpawnOptions } from "@lando/sdk/services";
import { Cause, Effect, Exit, Layer, Queue, Stream } from "effect";
import { bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { redactPluginPackageError } from "../../src/cli/commands/plugin-package-error.ts";
import { processRunnerFor } from "../_support/process-runner.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

const noOutput = processRunnerFor(() => Effect.succeed({ exitCode: 0 }));
const eventsLayer = (events: LandoEvent[]) =>
  Layer.succeed(
    EventService,
    EventService.of({
      publish: (event) => Effect.sync(() => events.push(event)),
      subscribe: () => Stream.empty,
      subscribeQueue: Queue.unbounded<never>(),
      subscribeWithHistory: () => Effect.never,
      waitFor: () => Effect.never,
      waitForAny: () => Effect.never,
      query: () => Effect.succeed([]),
    }),
  );

test("caller overrides preserve Bun mode, the reentry guard, and credentials", async () => {
  let request: ProcessSpawnOptions | undefined;
  await Effect.runPromise(
    bunSelfRun({
      argv: ["--version"],
      env: {
        BUN_BE_BUN: "0",
        LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "0",
        NPM_TOKEN: "x",
      },
    }).pipe(
      Effect.provideService(
        ProcessRunner,
        processRunnerFor((input) =>
          Effect.sync(() => {
            request = input;
            return { exitCode: 0 };
          }),
        ),
      ),
    ),
  );
  expect(request?.env).toMatchObject({
    BUN_BE_BUN: "1",
    LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "1",
    NPM_TOKEN: "x",
  });
});

test("BunSelfReentryError carries execPath verb callerSubsystem without exit or cause", async () => {
  const error = await withEnvVar("LANDO_DISALLOW_BUN_BE_BUN_REENTRY", "1", () =>
    Effect.runPromise(
      Effect.flip(
        bunSelfRun({
          argv: ["run", "script"],
          execPath: "/opt/bun",
          verb: "run",
          callerSubsystem: "cli:meta:bun",
          env: { LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "0" },
        }).pipe(Effect.provideService(ProcessRunner, noOutput)),
      ),
    ),
  );
  expect(error).toBeInstanceOf(BunSelfReentryError);
  expect(error).toMatchObject({ execPath: "/opt/bun", verb: "run", callerSubsystem: "cli:meta:bun" });
  expect(error).not.toHaveProperty("exitCode");
  expect(error).not.toHaveProperty("cause");
});

test.skipIf(process.platform === "win32")(
  "interruption keeps the launcher until execution finalizes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-interruption-"));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let launcher = "";
    try {
      await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const runner = processRunnerFor((input) =>
        Effect.gen(function* () {
          launcher = Bun.which("lando", { PATH: input.env?.PATH ?? "" }) ?? "";
          yield* Effect.addFinalizer(() => Effect.promise(() => release.promise));
          started.resolve();
          return yield* Effect.never;
        }).pipe(Effect.scoped),
      );
      const running = Effect.runPromiseExit(
        bunSelfRun({ argv: ["run", "v"], env: { PATH: root } }).pipe(
          Effect.provideService(ProcessRunner, runner),
        ),
        { signal: controller.signal },
      );
      await started.promise;
      controller.abort();
      await access(launcher);
      release.resolve();
      const result = await running;
      expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true);
      await expect(access(dirname(launcher))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("launcher preparation fails with FileIoError", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-preparation-"));
  try {
    await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await withEnvVar("TMPDIR", join(root, "missing"), async () => {
      const error = await Effect.runPromise(
        Effect.flip(
          bunSelfRun({ argv: ["--version"], env: { PATH: root } }).pipe(
            Effect.provideService(ProcessRunner, noOutput),
          ),
        ),
      );
      expect(error).toBeInstanceOf(FileIoError);
      expect(error).toMatchObject({ path: tmpdir(), cause: { code: "ENOENT" } });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32").each([0, 1, 7, 42])(
  "package child lando uses its launcher and cleans up after exit %i",
  async (exitCode) => {
    const root = await mkdtemp(join(tmpdir(), "lando-package-env-"));
    let launcher = "";
    try {
      await writeFile(
        join(root, "lando"),
        '#!/bin/sh\nprintf "%s|%s|%s|%s" "${BUN_BE_BUN-unset}" "${BUN_FEATURE_FLAG_NO_ORPHANS-unset}" "$LANDO_DISALLOW_BUN_BE_BUN_REENTRY" "$1"\n',
        { mode: 0o700 },
      );
      const runner = processRunnerFor((input) =>
        Effect.tryPromise({
          try: async () => {
            expect([input.cmd, ...input.args]).toEqual([process.execPath, "run", "v"]);
            expect(input.env).toMatchObject({ BUN_BE_BUN: "1", LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "1" });
            launcher = Bun.which("lando", { PATH: input.env?.PATH ?? "", cwd: root }) ?? "";
            const child = Bun.spawn([launcher, "version"], {
              ...(input.env === undefined ? {} : { env: input.env }),
              stdout: "pipe",
              stderr: "pipe",
            });
            expect(await new Response(child.stdout).text()).toBe("unset|unset|1|version");
            expect(await child.exited).toBe(0);
            return { exitCode };
          },
          catch: (cause) =>
            new ProcessExecError({ cmd: input.cmd, message: String(cause), remediation: "Fix fixture." }),
        }),
      );
      const result = await Effect.runPromise(
        bunSelfRun({
          argv: ["run", "v"],
          cwd: root,
          env: { PATH: root, BUN_FEATURE_FLAG_NO_ORPHANS: "1" },
        }).pipe(Effect.provideService(ProcessRunner, runner)),
      );
      expect(result.exitCode).toBe(exitCode);
      expect(dirname(launcher)).not.toBe(root);
      await expect(access(dirname(launcher))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([0, 1, 7, 42])(
  "completed exit %i returns data and publishes one pre/post pair",
  async (exitCode) => {
    const events: LandoEvent[] = [];
    const result = await Effect.runPromise(
      bunSelfRun({
        argv: ["--version"],
        execPath: "/bin/bun",
        verb: "version",
        callerSubsystem: "cli:meta:bun",
      }).pipe(
        Effect.provideService(
          ProcessRunner,
          processRunnerFor(() => Effect.succeed({ exitCode })),
        ),
        Effect.provide(eventsLayer(events)),
      ),
    );
    expect(result).toEqual({ mode: "collected", exitCode, stdout: "", stderr: "" });
    expect(events.map((event) => event._tag)).toEqual(["pre-bun-self-exec", "post-bun-self-exec"]);
    expect(events[1]).toMatchObject({
      exitCode,
      verb: "version",
      callerSubsystem: "cli:meta:bun",
      mode: "embedded",
    });
  },
);

test.each(["sync", "async"] as const)(
  "ProcessExecError on %s rejection has no post event or child status",
  async (mode) => {
    const events: LandoEvent[] = [];
    const runner = processRunnerFor((input) =>
      Effect.tryPromise({
        try: () => {
          if (mode === "sync") throw new Error("sync failure");
          return Promise.reject(new Error("async failure"));
        },
        catch: (cause) =>
          new ProcessExecError({
            cmd: input.cmd,
            cwd: input.cwd,
            message: String(cause),
            cause,
            remediation: "Check executable.",
          }),
      }),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        bunSelfRun({ argv: [], execPath: "/resolved/bin/bun" }).pipe(
          Effect.provideService(ProcessRunner, runner),
          Effect.provide(eventsLayer(events)),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ProcessExecError);
    expect(error).toMatchObject({ cmd: "/resolved/bin/bun" });
    expect(error.cause).toBeDefined();
    expect(error).not.toHaveProperty("exitCode");
    expect(events.map((event) => event._tag)).toEqual(["pre-bun-self-exec"]);
  },
);

test("redacts package failure context without changing observed status", async () => {
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["topsecret"]));
  const result = await Effect.runPromise(
    redactPluginPackageError(
      new PluginPackageOperationError({
        message: "install topsecret failed",
        remediation: "retry topsecret",
        commandId: "meta:plugin:add",
        operation: "postinstall",
        packageSpec: "@example/topsecret",
        cwd: "/plugins/topsecret",
        exitCode: 42,
        detail: "captured topsecret diagnostic",
      }),
    ).pipe(Effect.provideService(RedactionService, service)),
  );
  expect(result).toMatchObject({
    message: "install [redacted] failed",
    remediation: "retry [redacted]",
    packageSpec: "@example/[redacted]",
    cwd: "/plugins/[redacted]",
    detail: "captured [redacted] diagnostic",
    exitCode: 42,
  });
});

test("redacts free-text Bun lifecycle fields without adding output", async () => {
  const events: LandoEvent[] = [];
  const root = await mkdtemp(join(tmpdir(), "topsecret-project-"));
  try {
    await Effect.runPromise(
      bunSelfRun({
        argv: ["install", "--registry=https://topsecret.example"],
        cwd: root,
        env: { BUN_AUTH_TOKEN: "topsecret" },
        callerSubsystem: "plugin-topsecret",
        verb: "install-topsecret",
      }).pipe(
        Effect.provideService(ProcessRunner, noOutput),
        Effect.provide(eventsLayer(events)),
        Effect.provide(RedactionService.layer),
      ),
    );
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        event._tag === "pre-bun-self-exec"
          ? ["_tag", "argv", "callerSubsystem", "cwd", "mode", "timestamp", "verb"]
          : ["_tag", "argv", "callerSubsystem", "cwd", "exitCode", "mode", "timestamp", "verb"],
      );
      expect(JSON.stringify(event)).not.toContain("topsecret");
      expect(JSON.stringify(event)).toContain("[redacted]");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured Bun retains bounded stdout, stderr, and a nonzero status", async () => {
  const result = await Effect.runPromise(
    bunSelfRun({
      argv: [
        "-e",
        'await Bun.write(Bun.stdout,"x".repeat(1048576)); await Bun.write(Bun.stderr,"package failed"); process.exit(7)',
      ],
    }).pipe(Effect.provide(BunProcessRunner.layer)),
  );
  expect(result).toMatchObject({ mode: "collected", exitCode: 7, stderr: "package failed" });
  if (result.mode !== "collected") throw new TypeError("Expected collection");
  expect(result.stdout.length).toBe(1048576);
});

test("null proxy plan clears upper/lower/ALL_PROXY on the child env", async () => {
  let request: ProcessSpawnOptions | undefined;
  await Effect.runPromise(
    bunSelfRun({
      argv: ["--version"],
      env: {
        HTTP_PROXY: "http://ambient:1",
        http_proxy: "http://lower:1",
        HTTPS_PROXY: "http://ambient:2",
        ALL_PROXY: "http://all:7",
        all_proxy: "http://all-lower:8",
        NO_PROXY: "*",
      },
      networkPlan: { proxy: { noProxy: [] }, caCertPaths: [], trustHost: true },
    }).pipe(
      Effect.provideService(
        ProcessRunner,
        processRunnerFor((input) =>
          Effect.sync(() => {
            request = input;
            return { exitCode: 0 };
          }),
        ),
      ),
    ),
  );
  expect(request?.env?.HTTP_PROXY).toBeUndefined();
  expect(request?.env?.http_proxy).toBeUndefined();
  expect(request?.env?.HTTPS_PROXY).toBeUndefined();
  expect(request?.env?.ALL_PROXY).toBeUndefined();
  expect(request?.env?.all_proxy).toBeUndefined();
  expect(request?.env?.NO_PROXY).toBeUndefined();
  expect(request?.env).toMatchObject({ BUN_BE_BUN: "1" });
});

test("explicit proxy plan beats ambient variants including ALL_PROXY", async () => {
  let request: ProcessSpawnOptions | undefined;
  await Effect.runPromise(
    bunSelfRun({
      argv: ["--version"],
      env: {
        HTTP_PROXY: "http://ambient:1",
        ALL_PROXY: "http://all:7",
        NO_PROXY: "ambient",
      },
      networkPlan: {
        proxy: { http: "http://plan:80", https: "http://plan:443", noProxy: ["localhost"] },
        caCertPaths: [],
        trustHost: true,
      },
    }).pipe(
      Effect.provideService(
        ProcessRunner,
        processRunnerFor((input) =>
          Effect.sync(() => {
            request = input;
            return { exitCode: 0 };
          }),
        ),
      ),
    ),
  );
  expect(request?.env).toMatchObject({
    HTTP_PROXY: "http://plan:80",
    HTTPS_PROXY: "http://plan:443",
    NO_PROXY: "localhost",
  });
  expect(request?.env?.ALL_PROXY).toBeUndefined();
});

test("removeEnv strips conflicting inherited tokens while keeping explicit secrets", async () => {
  let request: ProcessSpawnOptions | undefined;
  await Effect.runPromise(
    bunSelfRun({
      argv: ["publish"],
      env: {
        BUN_CONFIG_TOKEN: "publish-token",
        BUN_AUTH_TOKEN: "legacy-auth",
        NPM_CONFIG_TOKEN: "npm-token",
        npm_config_token: "npm-lower",
      },
      removeEnv: ["BUN_AUTH_TOKEN", "NPM_CONFIG_TOKEN"],
      networkPlan: { proxy: { noProxy: [] }, caCertPaths: [], trustHost: true },
    }).pipe(
      Effect.provideService(
        ProcessRunner,
        processRunnerFor((input) =>
          Effect.sync(() => {
            request = input;
            return { exitCode: 0 };
          }),
        ),
      ),
    ),
  );
  expect(request?.env?.BUN_CONFIG_TOKEN).toBe("publish-token");
  expect(request?.env?.BUN_AUTH_TOKEN).toBeUndefined();
  expect(request?.env?.NPM_CONFIG_TOKEN).toBeUndefined();
  expect(request?.env?.npm_config_token).toBeUndefined();
});

test("strict package verb receives --cafile and not NODE_EXTRA_CA_CERTS", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-runner-ca-"));
  try {
    const ca = join(root, "ca.pem");
    const { rootCertificates } = await import("node:tls");
    const pem = rootCertificates[0];
    if (pem === undefined) throw new Error("Missing runtime root certificates");
    await writeFile(ca, pem);
    let request: ProcessSpawnOptions | undefined;
    await Effect.runPromise(
      bunSelfRun({
        argv: ["install"],
        env: {
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
          NODE_EXTRA_CA_CERTS: join(root, "should-not-leak.pem"),
        },
        networkPlan: {
          proxy: { noProxy: [] },
          caCertPaths: [ca],
          trustHost: false,
        },
      }).pipe(
        Effect.provideService(
          ProcessRunner,
          processRunnerFor((input) =>
            Effect.sync(() => {
              request = input;
              return { exitCode: 0 };
            }),
          ),
        ),
      ),
    );
    expect(request?.args?.[0]).toBe("install");
    expect(request?.args?.[1]).toBe("--cafile");
    expect(typeof request?.args?.[2]).toBe("string");
    expect(request?.env?.NODE_EXTRA_CA_CERTS).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
