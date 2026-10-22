import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../../bin/lando.ts");
const fixture = async (body: string) => {
  const root = await mkdtemp(join(tmpdir(), "lando-config-cli-"));
  await writeFile(join(root, "config.yml"), body);
  await writeFile(join(root, ".lando.yml"), "name: config-snapshot\nservices: {}\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("LANDO_")));
  const run = async (args: readonly string[], overrides: Readonly<Record<string, string>> = {}) => {
    const child = Bun.spawn([process.execPath, entry, ...args], {
      cwd: root,
      env: {
        ...env,
        LANDO_USER_CONF_ROOT: root,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
        LANDO_TELEMETRY: "false",
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  };
  return { root, run, close: () => rm(root, { recursive: true, force: true }) };
};

test.each(
  [
    ["info"],
    ["start"],
    ["list"],
    ["plugin:remove", "example"],
    ["app:config:lint"],
    ["global:config"],
    ["mcp", "--list"],
  ].map((args) => ({ args })),
)("$args returns sourced ConfigError at bootstrap", async ({ args }) => {
  const temp = await fixture("router:\n  httpPort: 99999\n");
  try {
    const result = await temp.run([...args, "--format=json"]);
    expect(result.code).toBe(1);
    const document = JSON.parse(result.stdout);
    const envelope = document._tag === "result" ? document.envelope : document;
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        _tag: "ConfigError",
        issues: [
          {
            path: ["router", "httpPort"],
            source: {
              layer: "config-file",
              file: join(temp.root, "config.yml"),
              path: ["router", "httpPort"],
            },
          },
        ],
      },
    });
  } finally {
    await temp.close();
  }
});

test("repair commands remain available under invalid config and notification promotion", async () => {
  const temp = await fixture(
    "router:\n  httpPort: 99999\nnotify:\n  enabled: true\n  commands:\n    - meta:config\n    - meta:doctor\n    - meta:uninstall\n    - meta:shellenv\n",
  );
  try {
    for (const args of [
      ["config", "view", "--source=raw"],
      ["version"],
      ["shellenv"],
      ["uninstall", "--help"],
      ["uninstall", "--dry-run"],
    ]) {
      const result = await temp.run([...args, "--format=json"]);
      expect({ args, code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });
      expect(result.stdout).not.toContain('"_tag":"ConfigError"');
    }
    const invalid = await temp.run(["config", "validate", "--format=json"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stdout).error._tag).toBe("ConfigError");
    const doctor = await temp.run(["doctor", "--format=json"]);
    expect(doctor.code).toBe(1);
    const report = JSON.parse(doctor.stdout).result;
    expect(report.globalConfig).toMatchObject({ status: "fail", error: { _tag: "ConfigError" } });
    expect(report.skipped).toHaveLength(6);
    expect(
      report.subsystems.checks.some((check: { readonly name: string }) => check.name === "filesystem-watch"),
    ).toBe(true);
    expect(doctor.stdout).not.toContain("--fix");
    const repaired = await temp.run(["config", "unset", "router.httpPort", "--format=json"]);
    expect(repaired.code).toBe(0);
    const valid = await temp.run(["config", "validate", "--format=json"]);
    expect(valid.code).toBe(0);
  } finally {
    await temp.close();
  }
}, 30_000);

test("source info prints a config typo warning once", async () => {
  const temp = await fixture("defaultProvidreId: docker\n");
  try {
    const result = await temp.run(["info"]);
    expect(result.code).toBe(0);
    expect(result.stderr.match(/defaultProvidreId/g)).toHaveLength(1);
  } finally {
    await temp.close();
  }
});

test("info keeps malformed YAML secrets out of its error envelope", async () => {
  // Given malformed secret-bearing global configuration.
  const secret = "opaque-canary-info-yaml";
  const temp = await fixture(`tracing:\n  otlp:\n    headers: [${secret}\n`);
  try {
    // When a normal command bootstraps.
    const result = await temp.run(["info", "--format=json"]);
    // Then the envelope reports a safe syntax diagnostic.
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      _tag: "ConfigError",
      message: expect.stringContaining("line 3, column 14"),
    });
  } finally {
    await temp.close();
  }
});

test("invalid presentation config cannot block doctor or config repair", async () => {
  // Given invalid presentation overrides and an independently invalid port.
  const temp = await fixture("router:\n  httpPort: 99999\n");
  const env = {
    LANDO_CONFIG__RENDERER: "invalid",
    LANDO_CONFIG__LOG_LEVEL: "invalid",
    LANDO_DOCTOR_SECTION_BUDGET_MS: "1000",
  };
  try {
    // When doctor and repair dispatch through the source CLI.
    const doctor = await temp.run(["doctor", "--app", "--deprecations", "--format=json"], env);
    const repair = await temp.run(["config", "unset", "router.httpPort", "--format=json"], env);
    const flag = await temp.run(["doctor", "--renderer=invalid", "--format=json"], env);
    // Then doctor reports config issues and independent checks, repair works, and explicit flags still fail.
    const report = JSON.parse(doctor.stdout).result;
    expect(doctor.code).toBe(1);
    expect(
      report.globalConfig.error.issues.map((issue: { readonly path: readonly string[] }) => issue.path),
    ).toEqual(expect.arrayContaining([["renderer"], ["logLevel"], ["router", "httpPort"]]));
    expect(
      report.subsystems.checks.some((check: { readonly name: string }) => check.name === "filesystem-watch"),
    ).toBe(true);
    expect(report.skipped.map((entry: { readonly section: string }) => entry.section)).toEqual(
      expect.arrayContaining(["app-config", "app-version-constraints", "deprecations"]),
    );
    expect(doctor.stdout).not.toContain("--fix");
    expect(repair.code).toBe(0);
    expect(JSON.parse(repair.stdout).warnings).toMatchObject([{ code: "LANDO_CONFIG_OTHER_SOURCE_INVALID" }]);
    expect(flag.code).not.toBe(0);
    expect(JSON.parse(flag.stdout).error._tag).toBe("RendererSelectionError");
  } finally {
    await temp.close();
  }
});

test.each(["text", "json"] as const)(
  "config get and doctor deliver a config warning once in %s",
  async (format) => {
    // Given an unknown global config key and bounded doctor probes.
    const temp = await fixture("defaultProvidreId: docker\n");
    try {
      // When reading config and running safe-mode doctor.
      const results = await Promise.all(
        [["config", "get", "defaultProviderId"], ["doctor"]].map((args) =>
          temp.run([...args, ...(format === "json" ? ["--format=json"] : [])], {
            LANDO_DOCTOR_SECTION_BUDGET_MS: "1000",
          }),
        ),
      );
      // Then each command renders or envelopes the same warning exactly once.
      for (const result of results) {
        if (format === "text") expect(result.stderr.match(/defaultProvidreId/g)).toHaveLength(1);
        else
          expect(JSON.parse(result.stdout).warnings).toEqual([
            expect.objectContaining({
              code: "LANDO_MESSAGE_WARN",
              message: expect.stringContaining("defaultProvidreId"),
            }),
          ]);
      }
    } finally {
      await temp.close();
    }
  },
  30_000,
);

test.each(["text", "json"] as const)(
  "config repair delivers its other-source warning once in %s",
  async (format) => {
    // Given a valid file candidate and an invalid independent environment layer.
    const temp = await fixture("router:\n  httpPort: 8080\n");
    try {
      // When removing a file setting while the other source remains invalid.
      const result = await temp.run(
        ["config", "unset", "router.httpPort", ...(format === "json" ? ["--format=json"] : [])],
        { LANDO_ROUTER_HTTPS_PORT: "99999" },
      );
      // Then the write succeeds and the warning reaches the chosen surface once.
      expect(result.code).toBe(0);
      if (format === "text") expect(result.stderr.match(/Invalid global configuration/g)).toHaveLength(1);
      else
        expect(JSON.parse(result.stdout).warnings).toEqual([
          expect.objectContaining({ code: "LANDO_CONFIG_OTHER_SOURCE_INVALID" }),
        ]);
    } finally {
      await temp.close();
    }
  },
);

test.each(["text", "json"] as const)(
  "config repair delivers remaining pre-existing issues once in %s",
  async (format) => {
    // Given three independent problems in the file being repaired.
    const temp = await fixture(
      "# my comment\nrouter:\n  httpPort: 99999\ndefaultProvidreId: docker\ntracing:\n  otlp:\n    headers: scalar\n",
    );
    try {
      // When unsetting only one invalid key.
      const result = await temp.run(["config", "unset", "router.httpPort", `--format=${format}`]);
      // Then the command succeeds and each remaining issue and its fix appears once.
      expect(result.code).toBe(0);
      if (format === "text") {
        expect(result.stderr.match(/Pre-existing issues remain/g)).toHaveLength(1);
        expect(result.stderr.match(/defaultProvidreId:/g)).toHaveLength(1);
        expect(result.stderr.match(/tracing\.otlp\.headers:/g)).toHaveLength(1);
        expect(result.stderr).toContain("lando config unset");
      } else {
        const warnings = JSON.parse(result.stdout).warnings;
        expect(warnings).toEqual([expect.objectContaining({ code: "LANDO_CONFIG_PREEXISTING_ISSUES" })]);
        expect(warnings[0].message.match(/defaultProvidreId:/g)).toHaveLength(1);
        expect(warnings[0].message.match(/tracing\.otlp\.headers:/g)).toHaveLength(1);
        expect(warnings[0].message).toContain("lando config unset");
        expect(result.stderr).not.toContain("Pre-existing issues remain");
      }
    } finally {
      await temp.close();
    }
  },
);
