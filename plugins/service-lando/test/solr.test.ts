import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { solr9ServiceType } from "../src/services/solr.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planSolrService = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { search: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("search")];
  if (service === undefined) throw new Error("search service missing");

  return solr9ServiceType.__legacyToServicePlan({
    name: "search",
    service,
    appRoot: "/srv/apps/myapp",
    metadata,
  });
};

describe("solr ServiceType", () => {
  test("plans a default Solr 9 service with persistent data volume and HTTP endpoint", () => {
    const plan = planSolrService({ type: "solr" });

    expect(plan.type).toBe("solr");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "solr:9" });
    expect(plan.command).toEqual(["solr-foreground", "-p", "8983"]);
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-solr-data");
    expect(String(plan.storage[0]?.target)).toBe("/var/solr");
    expect(plan.endpoints).toEqual([{ port: 8983, protocol: "http", name: "search" }]);
  });

  test("respects image, port, and command overrides", () => {
    const plan = planSolrService({
      type: "solr",
      image: "solr:8",
      port: 18983,
      command: ["solr-foreground", "-p", "18983"],
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "solr:8" });
    expect(plan.command).toEqual(["solr-foreground", "-p", "18983"]);
    expect(plan.endpoints[0]?.port).toBe(18983);
  });

  test("default command tracks the overridden port", () => {
    const plan = planSolrService({ type: "solr", port: 18983 });

    expect(plan.command).toEqual(["solr-foreground", "-p", "18983"]);
    expect(plan.endpoints[0]?.port).toBe(18983);
  });

  test("includes a curl-based command healthcheck on the system info endpoint", () => {
    const plan = planSolrService({ type: "solr" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "curl -sf http://localhost:8983/solr/admin/info/system"],
      intervalSeconds: 15,
      timeoutSeconds: 10,
      retries: 5,
      startPeriodSeconds: 60,
    });
  });

  test("healthcheck command tracks the overridden port", () => {
    const plan = planSolrService({ type: "solr", port: 18983 });

    expect(plan.healthcheck?.command).toEqual([
      "bash",
      "-c",
      "curl -sf http://localhost:18983/solr/admin/info/system",
    ]);
  });

  test("with a single cores entry the command uses precreate-core before solr-foreground", () => {
    const plan = planSolrService({ type: "solr", cores: ["gettingstarted"] });

    expect(plan.command).toEqual([
      "bash",
      "-c",
      'port="$1"; shift; for core in "$@"; do precreate-core "$core"; done; exec solr-foreground -p "$port"',
      "lando-solr-precreate",
      "8983",
      "gettingstarted",
    ]);
  });

  test("with multiple cores entries the command chains all precreate-core calls", () => {
    const plan = planSolrService({ type: "solr", cores: ["core1", "core2"] });

    expect(plan.command).toEqual([
      "bash",
      "-c",
      'port="$1"; shift; for core in "$@"; do precreate-core "$core"; done; exec solr-foreground -p "$port"',
      "lando-solr-precreate",
      "8983",
      "core1",
      "core2",
    ]);
  });

  test("cores command uses the overridden port in solr-foreground invocation", () => {
    const plan = planSolrService({ type: "solr", cores: ["mycore"], port: 18983 });

    expect(plan.command).toEqual([
      "bash",
      "-c",
      'port="$1"; shift; for core in "$@"; do precreate-core "$core"; done; exec solr-foreground -p "$port"',
      "lando-solr-precreate",
      "18983",
      "mycore",
    ]);
  });

  test.each([["bad core"], ["bad;core"], ["bad$(core)"], ["bad`core`"], ["bad\ncore"]])(
    "rejects unsafe core name %p",
    (core) => {
      expect(() => planSolrService({ type: "solr", cores: [core] })).toThrow(/Invalid Solr core name/);
    },
  );

  test("explicit command override is respected even when cores are configured", () => {
    const plan = planSolrService({
      type: "solr",
      cores: ["mycore"],
      command: ["solr-foreground", "-p", "8983"],
    });

    expect(plan.command).toEqual(["solr-foreground", "-p", "8983"]);
  });

  test("sets LANDO environment variables for service context", () => {
    const plan = planSolrService({ type: "solr" });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("search");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("solr");
  });

  test("user environment variables merge into the plan environment", () => {
    const plan = planSolrService({
      type: "solr",
      environment: { EXTRA_VAR: "extra" },
    });

    expect(plan.environment.EXTRA_VAR).toBe("extra");
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    expect(() => planSolrService({ type: "solr", environment: { LANDO_SERVICE_NAME: "evil" } })).toThrow(
      /reserved LANDO_\* keys.*LANDO_SERVICE_NAME/,
    );
  });
});
