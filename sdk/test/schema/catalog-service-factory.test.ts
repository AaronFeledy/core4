import { expect, test } from "bun:test";
import { MssqlServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";
import { catalogServiceConfig, catalogServiceType } from "../../src/schema/services/_catalog.ts";

test("preserves field order when building SQL Server configuration", () => {
  // Given the public SQL Server schema.
  // When inspecting its authoring fields.
  const keys = Object.keys(MssqlServiceConfig.fields);
  // Then shared fields, extras, and type retain the original order.
  expect(keys).toEqual([
    "image",
    "command",
    "entrypoint",
    "user",
    "workingDirectory",
    "database",
    "creds",
    "port",
    "environment",
    "envFile",
    "labels",
    "ports",
    "networks",
    "appMount",
    "mounts",
    "storage",
    "endpoints",
    "routes",
    "healthcheck",
    "security",
    "dependsOn",
    "providers",
    "type",
  ]);
});

test("includes only selected and assigned fields when keys override the shared selection", () => {
  // Given / When
  const schema = catalogServiceConfig({
    keys: ["image"],
    type: catalogServiceType(Schema.Literal("example"), "Example type."),
    fields: { backend: Schema.String },
    identifier: "Example",
    title: "Example",
    description: "Example config.",
  });
  // Then
  expect(Object.keys(schema.fields)).toEqual(["image", "type", "backend"]);
});
