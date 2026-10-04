import { describe, expect, test } from "bun:test";

import { PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import { serviceTypes } from "../src/index.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const planService = (serviceType: ServiceType, fields: ServiceConfig) =>
  composeServicePlan({
    serviceType: {
      ...serviceType,
      resolve: (input) =>
        serviceType.resolve({
          ...input,
          projectFiles: [{ path: ".nvmrc", present: true, text: "22", sha256: "sha256:.nvmrc:2" }],
        }),
    },
    service: {
      type: serviceType.id,
      ...(serviceType.id === "compose" || serviceType.id === "lando" ? { image: "alpine:3" } : {}),
      ...(serviceType.name === "varnish" ? { backend: "backend" } : {}),
      ...fields,
    },
    appName: "authored-process",
    appRoot: "/srv/authored-process",
    metadata: {
      resolvedAt: "2026-10-02T00:00:00Z",
      source: "/srv/authored-process/.lando.yml",
      runtime: 4,
    },
  });

describe.each([...serviceTypes])("%s authored process fields", (_id, serviceType) => {
  test("preserves all overrides when process fields are authored", async () => {
    const authored = {
      command: ["custom-command", "--custom-argument"],
      entrypoint: ["custom-entrypoint"],
      workingDirectory: PortablePath.make("/custom-directory"),
      user: "custom-user",
    };

    const plan = await planService(serviceType, authored);

    expect(plan.command).toEqual(authored.command);
    expect(plan.entrypoint).toEqual(authored.entrypoint);
    expect(plan.workingDirectory).toBe(authored.workingDirectory);
    expect(plan.user).toBe(authored.user);
  });

  test.each([{ command: "" }, { command: [] }])(
    "keeps empty startup overrides when supplied as $command",
    async ({ command }) => {
      const fields = { command, entrypoint: command };

      const plan = await planService(serviceType, fields);

      expect(plan.command).toEqual(command);
      expect(plan.entrypoint).toEqual(command);
    },
  );
});
