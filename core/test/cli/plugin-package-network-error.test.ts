import { expect, test } from "bun:test";
import { Effect } from "effect";
import { BunChildNetworkPolicyError } from "../../src/cli/commands/bun-child-network-policy";
import { failPluginNetworkPolicy } from "../../src/cli/commands/plugin-package-error";

test("plugin postinstall preserves network remediation within its package error contract", async () => {
  const error = new BunChildNetworkPolicyError({
    kind: "empty-strict-trust",
    message: "No configured CAs.",
    remediation: "Configure a PEM file.",
  });

  const result = await Effect.runPromise(
    Effect.flip(
      failPluginNetworkPolicy(error, {
        commandId: "meta:plugin:add",
        packageSpec: "@acme/plugin",
        cwd: "/isolated/plugin",
      }),
    ),
  );

  expect(result).toMatchObject({
    _tag: "PluginPackageOperationError",
    operation: "postinstall",
    detail: "BunChildNetworkPolicyError: empty-strict-trust",
    remediation: "Configure a PEM file.",
    commandId: "meta:plugin:add",
    packageSpec: "@acme/plugin",
    cwd: "/isolated/plugin",
  });
});
