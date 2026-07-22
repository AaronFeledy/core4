import { expect, test } from "bun:test";

import { buildToolingInvocation } from "../../src/cli/commands/tooling.ts";

test("preserves pass-through argument boundaries for string tooling commands", () => {
  // Given
  const task = { service: "appserver", cmds: ["vendor/bin/drush"] };

  // When
  const invocation = buildToolingInvocation("drush", task, {
    args: ["site:install", "--site-name=Lando Drupal 11", "", "$(touch /tmp/unwanted)", "it's-safe"],
  });

  // Then
  expect(invocation.commands).toEqual([
    [
      "sh",
      "-c",
      "vendor/bin/drush site:install '--site-name=Lando Drupal 11' '' '$(touch /tmp/unwanted)' 'it'\"'\"'s-safe'",
    ],
  ]);
});
