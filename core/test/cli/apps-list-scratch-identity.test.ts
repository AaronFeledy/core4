import { expect, test } from "bun:test";
import { appsFromContainerList } from "../../src/cli/commands/list-discovery";

test("preserves scratch identity when discovering labeled containers", () => {
  // Given: a scratch container and a regular app with a scratch-prefixed name.
  const containers = [
    { State: "running", Labels: { "dev.lando.app": "scratch-ephemeral", "dev.lando.scratch": "TRUE" } },
    { State: "running", Labels: { "dev.lando.app": "scratch-project" } },
  ];
  // When: poweroff's discovery includes scratch apps.
  const apps = appsFromContainerList(containers, { includeScratch: true });
  // Then: lifecycle selection can use the label instead of guessing from a name.
  expect(apps.find((app) => app.appId === "scratch-ephemeral")?.scratch).toBe(true);
  expect(apps.find((app) => app.appId === "scratch-project")?.scratch).not.toBe(true);
});
