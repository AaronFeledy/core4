import { describe, expect, test } from "bun:test";

import {
  OOM_CHECK_NAME,
  buildOomDoctorCheck,
  classifyDiedEvent,
  collectOomDoctorChecks,
} from "../../src/cli/commands/doctor-oom.ts";
import { renderDoctorResult, renderDoctorResultAsNdjson } from "../../src/cli/commands/doctor.ts";

const PROVIDER = { id: "lando", displayName: "Lando Managed Runtime", version: "0.0.0" } as const;
const CONTEXT = { provider: PROVIDER, providerKind: "managed" as const, platform: "linux" as const };

const solutionText = (solutions: ReadonlyArray<{ readonly description: string }>): string =>
  solutions
    .map((solution) => solution.description)
    .join(" ")
    .toLowerCase();

const diedEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  Type: "container",
  Action: "died",
  Actor: {
    ID: "abc123",
    Attributes: {
      name: "lando-myapp-web",
      image: "docker.io/library/php:8.3",
      containerExitCode: "137",
      "dev.lando.app": "myapp",
      "dev.lando.service": "web",
    },
  },
  ...overrides,
});

describe("classifyDiedEvent", () => {
  test("OOMKilled present (boolean true) classifies as oom with app/service correlation", () => {
    const result = classifyDiedEvent(diedEvent({ OOMKilled: true }));
    expect(result.kind).toBe("oom");
    if (result.kind !== "oom") throw new Error("expected oom");
    expect(result.correlation.containerName).toBe("lando-myapp-web");
    expect(result.correlation.app).toBe("myapp");
    expect(result.correlation.service).toBe("web");
    expect(result.correlation.image).toBe("docker.io/library/php:8.3");
    expect(result.correlation.exitCode).toBe(137);
  });

  test("OOMKilled present as string 'true' classifies as oom", () => {
    const result = classifyDiedEvent(
      diedEvent({
        Actor: {
          Attributes: {
            name: "lando-x-db",
            OOMKilled: "true",
            "dev.lando.app": "x",
            "dev.lando.service": "db",
          },
        },
      }),
    );
    expect(result.kind).toBe("oom");
  });

  test("unowned OOMKilled died event classifies as unrelated", () => {
    const result = classifyDiedEvent(
      diedEvent({
        OOMKilled: true,
        Actor: { Attributes: { name: "external-db", image: "docker.io/library/postgres:16" } },
      }),
    );

    expect(result.kind).toBe("unrelated");
  });

  test("OOMKilled absent classifies as died (not oom) — preserves 'if set' semantics", () => {
    const result = classifyDiedEvent(diedEvent());
    expect(result.kind).toBe("died");
  });

  test("OOMKilled false classifies as died", () => {
    const result = classifyDiedEvent(diedEvent({ OOMKilled: false }));
    expect(result.kind).toBe("died");
  });

  test("malformed OOMKilled value is treated as not set (died), never throws", () => {
    const result = classifyDiedEvent(diedEvent({ OOMKilled: "maybe" }));
    expect(result.kind).toBe("died");
    const objValue = classifyDiedEvent(diedEvent({ OOMKilled: { nested: 1 } }));
    expect(objValue.kind).toBe("died");
  });

  test("non-object payload classifies as malformed, never throws", () => {
    expect(classifyDiedEvent(null).kind).toBe("malformed");
    expect(classifyDiedEvent("died").kind).toBe("malformed");
    expect(classifyDiedEvent(42).kind).toBe("malformed");
    expect(classifyDiedEvent([{ Action: "died" }]).kind).toBe("malformed");
  });

  test("died event with junk Actor degrades gracefully to died with empty correlation", () => {
    const result = classifyDiedEvent({
      Type: "container",
      Action: "died",
      Actor: "broken",
      OOMKilled: false,
    });
    expect(result.kind).toBe("died");
    if (result.kind !== "died") throw new Error("expected died");
    expect(result.correlation.containerName).toBeUndefined();
  });

  test("non-died container event classifies as unrelated", () => {
    expect(classifyDiedEvent(diedEvent({ Action: "start" })).kind).toBe("unrelated");
    expect(classifyDiedEvent(diedEvent({ Action: "create" })).kind).toBe("unrelated");
  });

  test("non-container died-ish event classifies as unrelated", () => {
    expect(classifyDiedEvent({ Type: "image", Action: "died" }).kind).toBe("unrelated");
  });

  test("object without recognizable event fields classifies as malformed", () => {
    expect(classifyDiedEvent({ foo: "bar" }).kind).toBe("malformed");
    expect(classifyDiedEvent({}).kind).toBe("malformed");
  });

  test("accepts Podman podman_event_name / Status spellings for died", () => {
    expect(classifyDiedEvent(diedEvent({ Status: "died", OOMKilled: true })).kind).toBe("oom");
    expect(classifyDiedEvent(diedEvent({ podman_event_name: "died", OOMKilled: true })).kind).toBe("oom");
  });

  test("accepts libpod die action spellings for container death events", () => {
    expect(classifyDiedEvent(diedEvent({ Action: "die", OOMKilled: true })).kind).toBe("oom");
    expect(classifyDiedEvent(diedEvent({ status: "die", OOMKilled: true })).kind).toBe("oom");
  });

  test("correlates app/service from compose labels when lando labels absent", () => {
    const result = classifyDiedEvent(
      diedEvent({
        OOMKilled: true,
        Actor: {
          Attributes: {
            name: "proj_svc_1",
            "com.docker.compose.project": "proj",
            "com.docker.compose.service": "svc",
          },
        },
      }),
    );
    expect(result.kind).toBe("oom");
    if (result.kind !== "oom") throw new Error("expected oom");
    expect(result.correlation.app).toBe("proj");
    expect(result.correlation.service).toBe("svc");
  });
});

describe("buildOomDoctorCheck", () => {
  test("oom classification produces a failure check with memory remediation", () => {
    const classification = classifyDiedEvent(diedEvent({ OOMKilled: true }));
    const check = buildOomDoctorCheck(classification, CONTEXT);
    expect(check).toBeDefined();
    if (check === undefined) throw new Error("expected check");
    expect(check.name).toBe(OOM_CHECK_NAME);
    expect(check.status).toBe("fail");
    expect(check.severity).toBe("error");
    expect(check.runtimeStatus).toBe("oom-killed");
    expect(check.runtime.running).toBe(false);
    expect(check.runtime.oomKilled).toBe(true);
    expect(check.providerId).toBe("lando");
    expect(check.providerKind).toBe("managed");
    const joined = solutionText(check.solutions);
    expect(joined).toContain("memory");
    expect(joined).toContain("logs");
    // correlation surfaced in context
    expect(check.context.app).toBe("myapp");
    expect(check.context.service).toBe("web");
    expect(check.context.exitCode).toBe("137");
  });

  test("non-oom classifications return undefined (no false diagnostic)", () => {
    expect(buildOomDoctorCheck(classifyDiedEvent(diedEvent()), CONTEXT)).toBeUndefined();
    expect(
      buildOomDoctorCheck(
        classifyDiedEvent(
          diedEvent({
            OOMKilled: true,
            Actor: { Attributes: { name: "external-db", image: "docker.io/library/postgres:16" } },
          }),
        ),
        CONTEXT,
      ),
    ).toBeUndefined();
    expect(
      buildOomDoctorCheck(classifyDiedEvent({ Type: "image", Action: "died" }), CONTEXT),
    ).toBeUndefined();
    expect(buildOomDoctorCheck(classifyDiedEvent(null), CONTEXT)).toBeUndefined();
  });

  test("macOS and Windows remediation mention Podman Desktop machine resource settings", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const check = buildOomDoctorCheck(classifyDiedEvent(diedEvent({ OOMKilled: true })), {
        ...CONTEXT,
        platform,
      });
      if (check === undefined) throw new Error("expected check");
      expect(solutionText(check.solutions)).toContain("podman desktop");
    }
  });

  test("linux and WSL remediation do not mention Podman Desktop", () => {
    for (const platform of ["linux", "wsl"] as const) {
      const check = buildOomDoctorCheck(classifyDiedEvent(diedEvent({ OOMKilled: true })), {
        ...CONTEXT,
        platform,
      });
      if (check === undefined) throw new Error("expected check");
      expect(solutionText(check.solutions)).not.toContain("podman desktop");
    }
  });

  test("redacts credential-bearing image and correlation before output", () => {
    const classification = classifyDiedEvent(
      diedEvent({
        OOMKilled: true,
        Actor: {
          Attributes: {
            name: "lando-secret-web",
            image: "oci://user:s3cr3t@registry.example.com/team/app:latest",
            "dev.lando.app": "https://user:pw@app.example.com",
            "dev.lando.service": "web",
          },
        },
      }),
    );
    const check = buildOomDoctorCheck(classification, CONTEXT);
    if (check === undefined) throw new Error("expected check");
    const serialized = JSON.stringify(check);
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("pw@app.example.com");
    expect(check.context.image).toContain("[redacted]");
  });
});

describe("collectOomDoctorChecks", () => {
  test("returns one check per oom-killed event, skipping non-oom and malformed", () => {
    const checks = collectOomDoctorChecks(
      [
        diedEvent({ OOMKilled: true }),
        diedEvent(),
        diedEvent({ Action: "start" }),
        null,
        diedEvent({
          OOMKilled: true,
          Actor: {
            Attributes: {
              name: "proj_db_1",
              "com.docker.compose.project": "proj",
              "com.docker.compose.service": "db",
            },
          },
        }),
      ],
      CONTEXT,
    );
    expect(checks.length).toBe(2);
    expect(checks.every((c) => c.name === OOM_CHECK_NAME)).toBe(true);
  });
});

describe("doctor rendering of oom checks", () => {
  test("text render surfaces oom status, remediation, and no raw secret payload", () => {
    const check = buildOomDoctorCheck(
      classifyDiedEvent(
        diedEvent({
          OOMKilled: true,
          Actor: {
            Attributes: {
              name: "lando-x-web",
              image: "oci://user:s3cr3t@r.example.com/a",
              "dev.lando.app": "x",
              "dev.lando.service": "web",
            },
          },
        }),
      ),
      CONTEXT,
    );
    if (check === undefined) throw new Error("expected check");
    const text = renderDoctorResult({ checks: [check] });
    expect(text).toContain(`${OOM_CHECK_NAME}: fail`);
    expect(text.toLowerCase()).toContain("memory");
    expect(text).not.toContain("s3cr3t");
  });

  test("ndjson render surfaces oomKilled in the runtime payload and stays redacted", () => {
    const check = buildOomDoctorCheck(
      classifyDiedEvent(
        diedEvent({
          OOMKilled: true,
          Actor: {
            Attributes: {
              name: "lando-x-web",
              image: "oci://user:s3cr3t@r.example.com/a",
              "dev.lando.app": "x",
              "dev.lando.service": "web",
            },
          },
        }),
      ),
      CONTEXT,
    );
    if (check === undefined) throw new Error("expected check");
    const ndjson = renderDoctorResultAsNdjson({ checks: [check] });
    const first = JSON.parse(ndjson.trim().split("\n")[0] ?? "{}") as {
      payload?: { runtime?: { oomKilled?: boolean } };
    };
    expect(first.payload?.runtime?.oomKilled).toBe(true);
    expect(ndjson).not.toContain("s3cr3t");
  });
});
