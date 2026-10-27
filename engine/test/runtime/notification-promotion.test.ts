import { expect, test } from "bun:test";
import { effectiveBootstrapForCommand } from "../../src/runtime/cli-options.ts";

test.each([
  "app:config",
  "app:config:set",
  "app:config:unset",
  "app:config:edit",
  "meta:global:config",
  "meta:global:config:set",
  "meta:global:config:unset",
  "meta:global:config:edit",
])("configured %s acquires observers without changing its default bootstrap", (id) => {
  // Given: a config command declared below the observer tier.
  const declared = "minimal";
  // When: notification policy selects the command.
  const selected = effectiveBootstrapForCommand(id, declared, [id]);
  // Then: only configured invocations promote.
  expect(selected).toBe("commands");
  expect(effectiveBootstrapForCommand(id, declared, [])).toBe(declared);
});

test.each(["meta:config", "meta:doctor", "meta:version", "meta:shellenv", "meta:uninstall"])(
  "%s retains safe-mode bootstrap even when configured for notification",
  (id) => {
    // Given: a repair or diagnostic command selected by notification policy.
    const configured = [id];
    // When: the cold dispatcher resolves its bootstrap.
    const selected = effectiveBootstrapForCommand(id, "none", configured);
    // Then: notification policy cannot force config validation or app discovery.
    expect(selected).toBe("none");
  },
);
