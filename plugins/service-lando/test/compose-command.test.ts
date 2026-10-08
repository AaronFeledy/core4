import { describe, expect, test } from "bun:test";
import { Effect, Result } from "effect";

import { composeService } from "@lando/engine/services/feature";
import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ProviderId, type ServiceConfig, ServiceName } from "@lando/sdk/schema";

import { serviceTypes } from "../src/index.ts";
import { composeServiceFeature, composeServiceType } from "../src/services/compose.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const plan = (fields: ServiceConfig) =>
  composeServicePlan({
    serviceType: composeServiceType,
    service: { type: "compose", image: "typesense/typesense:27.1", ...fields },
    appRoot: "/srv/compose-command",
    metadata: { resolvedAt: "2026-10-07T00:00:00Z", source: "/srv/compose-command/.lando.yml", runtime: 4 },
  });

describe("Compose process argv", () => {
  test.each(["lando", "node:22"])("preserves native %s string shell semantics", async (type) => {
    const serviceType = serviceTypes.get(type);
    if (serviceType === undefined) throw new Error(`Missing service type ${type}`);
    const command = "echo first && echo second";
    const service = await composeServicePlan({
      serviceType,
      service: { type, image: "alpine:3", command, entrypoint: command },
      appRoot: "/srv/compose-command",
      metadata: { resolvedAt: "2026-10-07T00:00:00Z", source: "/srv/compose-command/.lando.yml", runtime: 4 },
    });
    expect(service.command).toBe(command);
    expect(service.entrypoint).toBe(command);
  });

  test.each([
    {
      command: "--data-dir /data --api-key=xyz --enable-cors",
      argv: ["--data-dir", "/data", "--api-key=xyz", "--enable-cors"],
    },
    {
      command: `worker --title "two words" 'three words' escaped\\ space`,
      argv: ["worker", "--title", "two words", "three words", "escaped space"],
    },
    { command: ["worker", "embedded spaces", "", "a|b"], argv: ["worker", "embedded spaces", "", "a|b"] },
    { command: "", argv: [] },
    { command: " \t\n", argv: [] },
    { command: [], argv: [] },
    { command: "echo first && echo ignored", argv: ["echo", "first"] },
    { command: "echo first 2>ignored", argv: ["echo", "first"] },
    { command: `sh -c 'echo first && echo second'`, argv: ["sh", "-c", "echo first && echo second"] },
    {
      command: "echo $HOME ${TOKEN} $(printf secret) `printf secret`",
      argv: ["echo", "$HOME", "${TOKEN}", "$(printf secret)", "`printf secret`"],
    },
  ])("normalizes command and entrypoint when authored as $command", async ({ command, argv }) => {
    // Given
    const fields = { command, entrypoint: command };
    // When
    const service = await plan(fields);
    // Then
    expect(service.command).toEqual(argv);
    expect(service.entrypoint).toEqual(argv);
  });

  test("leaves process defaults absent when no override is authored", async () => {
    // Given / When
    const service = await plan({});
    // Then
    expect(service.command).toBeUndefined();
    expect(service.entrypoint).toBeUndefined();
  });

  test("preserves user and working directory when argv is normalized", async () => {
    // Given
    const fields = {
      command: "worker --serve",
      user: "worker",
      workingDirectory: PortablePath.make("/work"),
    };
    // When
    const service = await plan(fields);
    // Then
    expect(service.user).toBe(fields.user);
    expect(service.workingDirectory).toBe(fields.workingDirectory);
  });

  test.each(["command", "entrypoint"] as const)(
    "rejects malformed %s with a secret-free tagged error",
    async (field) => {
      // Given
      const command = `worker --token=private-token "unterminated`;
      // When
      const result = await Effect.runPromise(
        Effect.result(
          composeService({
            base: {
              name: ServiceName.make("web"),
              type: "compose",
              provider: ProviderId.make("lando"),
              primary: true,
              defaultFeatures: [],
            },
            baseKind: "l337",
            appRoot: "/srv/compose-command",
            normalizedConfig: { type: "compose", image: "alpine:3", [field]: command },
            features: [{ id: composeServiceFeature.id, definition: composeServiceFeature }],
          }),
        ),
      );
      // Then
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(ServiceFeatureError);
        expect(result.failure).toMatchObject({
          _tag: "ServiceFeatureError",
          feature: composeServiceFeature.id,
        });
        expect(JSON.stringify(result.failure)).not.toContain("private-token");
        expect(String(result.failure)).not.toContain("private-token");
      }
    },
  );
});
