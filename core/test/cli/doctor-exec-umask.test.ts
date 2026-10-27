import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { AppId, ProviderId, ServiceName } from "@lando/sdk/schema";

import {
  EXEC_UMASK_CHECK_NAME,
  buildExecUmaskDoctorCheck,
  collectExecUmaskDoctorCheck,
  diagnoseExecUmask,
} from "../../src/cli/commands/doctor-exec-umask.ts";

const provider = {
  id: "docker",
  displayName: "Docker Runtime Provider",
  version: "0.0.0",
};

const selection = {
  providerId: "docker",
  source: "flag" as const,
  inputs: { flag: "docker", capabilityDefault: "lando" },
};

const runtime = { running: true, version: "29.6.0" };

describe("diagnoseExecUmask", () => {
  test.each([undefined, "Umask:\t0000\n", "Umask:\t0077\n", "no umask line"])(
    "does not claim compensation without a verified effective 0022: %s",
    (effectiveStdout) => {
      const diagnosis = diagnoseExecUmask({
        engineVersion: "29.6.0",
        stdout: "Umask:\t0000\n",
        ...(effectiveStdout === undefined ? {} : { effectiveStdout }),
      });
      expect(diagnosis.compensating).toBe(false);
      const check = buildExecUmaskDoctorCheck(diagnosis, provider, runtime, "ready");
      expect(check.status).toBe("warn");
      expect(check.solutions).toEqual([]);
    },
  );
  test("reports compensation when the probed umask is 0000", () => {
    expect(
      diagnoseExecUmask({
        engineVersion: "29.6.0",
        stdout: "Name:\tcat\nUmask:\t0000\n",
        effectiveStdout: "Umask:\t0022\n",
      }),
    ).toEqual({
      engineVersion: "29.6.0",
      execUmask: "0000",
      effectiveExecUmask: "0022",
      compensating: true,
      probeStatus: "ok",
    });
  });

  test("does not compensate when the probed umask is not 0000", () => {
    expect(diagnoseExecUmask({ engineVersion: "28.0.4", stdout: "Umask:\t0022\n" })).toEqual({
      engineVersion: "28.0.4",
      execUmask: "0022",
      effectiveExecUmask: "0022",
      compensating: false,
      probeStatus: "ok",
    });
  });

  test("stays unprobed when no running service produced a umask line", () => {
    expect(diagnoseExecUmask({ engineVersion: undefined, stdout: undefined })).toEqual({
      engineVersion: "unknown",
      execUmask: "unprobed",
      effectiveExecUmask: "unprobed",
      compensating: false,
      probeStatus: "unprobed",
    });
  });
});

describe("buildExecUmaskDoctorCheck", () => {
  test("warns when Lando is compensating for umask 0000", () => {
    const check = buildExecUmaskDoctorCheck(
      {
        engineVersion: "29.6.0",
        execUmask: "0000",
        effectiveExecUmask: "0022",
        compensating: true,
        probeStatus: "ok",
      },
      provider,
      runtime,
      "ready",
      selection,
    );
    expect(check.name).toBe(EXEC_UMASK_CHECK_NAME);
    expect(check.status).toBe("warn");
    expect(check.context).toMatchObject({
      engineVersion: "29.6.0",
      execUmask: "0000",
      compensating: "true",
      probeStatus: "ok",
    });
    expect(check.solutions[0]?.description).toContain("reported 0022");
  });
});

describe("collectExecUmaskDoctorCheck", () => {
  test.each(["shellless", "unknown-shell", "failed", "transport", "stderr-only"])(
    "does not claim file protection when the shared exec probe is %s",
    async (outcome) => {
      const commands: Array<{ readonly raw?: boolean }> = [];
      const check = await Effect.runPromise(
        collectExecUmaskDoctorCheck({
          provider: {
            ...provider,
            list: () =>
              Effect.succeed([
                {
                  app: AppId.make("demo"),
                  service: ServiceName.make("web"),
                  providerId: ProviderId.make("docker"),
                  status: "running",
                  publications: { status: "unknown" as const },
                  containerId: "cid-web",
                },
              ]),
            exec: (_target, command) => {
              commands.push(command);
              if (command.raw === true)
                return Effect.succeed({ exitCode: 0, stdout: "Umask:\t0000\n", stderr: "" });
              if (outcome === "transport") return Effect.fail("unavailable");
              return Effect.succeed({
                exitCode: outcome === "failed" ? 127 : 0,
                stdout: outcome === "stderr-only" ? "" : "Umask:\t0000\n",
                stderr: "Umask:\t0022\n",
              });
            },
          },
          engineVersion: "29.6.0",
          runtime,
          runtimeStatus: "ready",
          selection,
        }),
      );
      expect(commands.map((command) => command.raw)).toEqual([true, undefined]);
      expect(check.context.compensating).toBe("false");
      expect(check.context.execUmask).toBe("0000");
      expect(check.context.effectiveExecUmask).toBe(
        outcome === "shellless" || outcome === "unknown-shell" ? "0000" : "unprobed",
      );
      expect(check.status).toBe("warn");
      expect(check.solutions).toEqual([]);
    },
  );
  test("probes a running service and reports the engine umask", async () => {
    const check = await Effect.runPromise(
      collectExecUmaskDoctorCheck({
        provider: {
          ...provider,
          list: () =>
            Effect.succeed([
              {
                app: AppId.make("demo"),
                service: ServiceName.make("web"),
                providerId: ProviderId.make("docker"),
                status: "running",
                publications: { status: "unknown" as const },
                containerId: "cid-web",
              },
            ]),
          exec: (_target, command) =>
            Effect.succeed({
              exitCode: 0,
              stdout: command.raw === true ? "Umask:\t0000\n" : "Umask:\t0022\n",
              stderr: "",
            }),
        },
        engineVersion: "29.6.0",
        runtime,
        runtimeStatus: "ready",
        selection,
      }),
    );

    expect(check.status).toBe("warn");
    expect(check.context.execUmask).toBe("0000");
    expect(check.context.compensating).toBe("true");
    expect(check.context.engineVersion).toBe("29.6.0");
  });

  test("stays unprobed when no service is running", async () => {
    const check = await Effect.runPromise(
      collectExecUmaskDoctorCheck({
        provider: {
          ...provider,
          list: () => Effect.succeed([]),
          exec: () => Effect.succeed({ exitCode: 0, stdout: "Umask:\t0000\n", stderr: "" }),
        },
        engineVersion: "28.0.4",
        runtime,
        runtimeStatus: "ready",
        selection,
      }),
    );

    expect(check.status).toBe("warn");
    expect(check.context.execUmask).toBe("unprobed");
    expect(check.context.compensating).toBe("false");
  });

  test("stays unprobed when the runtime is not running", async () => {
    let listCalls = 0;
    let execCalls = 0;
    const check = await Effect.runPromise(
      collectExecUmaskDoctorCheck({
        provider: {
          ...provider,
          list: () => {
            listCalls += 1;
            return Effect.succeed([
              {
                app: AppId.make("demo"),
                service: ServiceName.make("web"),
                providerId: ProviderId.make("docker"),
                status: "running",
                publications: { status: "unknown" as const },
                containerId: "cid-web",
              },
            ]);
          },
          exec: () => {
            execCalls += 1;
            return Effect.succeed({ exitCode: 0, stdout: "Umask:\t0000\n", stderr: "" });
          },
        },
        engineVersion: "29.6.0",
        runtime: { running: false, message: "runtime socket unreachable" },
        runtimeStatus: "runtime socket unreachable",
        selection,
      }),
    );

    expect(listCalls).toBe(0);
    expect(execCalls).toBe(0);
    expect(check.status).toBe("warn");
    expect(check.context.execUmask).toBe("unprobed");
    expect(check.context.compensating).toBe("false");
  });

  test("stays unprobed when the running service has no container id", async () => {
    let execCalls = 0;
    const check = await Effect.runPromise(
      collectExecUmaskDoctorCheck({
        provider: {
          ...provider,
          list: () =>
            Effect.succeed([
              {
                app: AppId.make("demo"),
                service: ServiceName.make("web"),
                providerId: ProviderId.make("docker"),
                status: "running",
                publications: { status: "unknown" as const },
              },
            ]),
          exec: () => {
            execCalls += 1;
            return Effect.succeed({ exitCode: 0, stdout: "Umask:\t0000\n", stderr: "" });
          },
        },
        engineVersion: "28.0.4",
        runtime,
        runtimeStatus: "ready",
        selection,
      }),
    );

    expect(execCalls).toBe(0);
    expect(check.status).toBe("warn");
    expect(check.context.execUmask).toBe("unprobed");
    expect(check.context.compensating).toBe("false");
  });
});
