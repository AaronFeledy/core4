import { Effect, Schema } from "effect";

import { splitComposeCommand } from "@lando/sdk/landofile";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { ServiceConfigIssue, serviceFeatureApply } from "./_feature-helpers.ts";

import { applyAuthoredProcessFields } from "./_process-helpers.ts";

export const COMPOSE_FEATURE_ID = "service-lando.compose" as const;
export const COMPOSE_FEATURE_PRIORITY = 600;
export const APP_MOUNT_TARGET = "/app";

const applyCompose = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const hasImage = service.image !== undefined && service.image.length > 0;
  const hasComposeBuild = service.build !== undefined && "context" in service.build;
  if (!hasImage && !hasComposeBuild) {
    throw new ServiceConfigIssue(
      ["type"],
      "A Compose service requires an image or build artifact.",
      'Set "image:" or "build:" (Compose build block).',
    );
  }

  if (hasImage) {
    ctx.setArtifact({ kind: "ref", ref: service.image as string });
  }

  for (const field of ["command", "entrypoint"] as const) {
    const authored = service[field];
    if (authored === undefined) continue;
    const argv = typeof authored === "string" ? splitComposeCommand(authored)?.argv : authored;
    if (argv === undefined) {
      throw new ServiceConfigIssue(
        [field],
        `Compose ${field} has malformed quoting or escaping.`,
        "Use valid quoting or an argv list.",
      );
    }
    switch (field) {
      case "command":
        ctx.setCommand(argv);
        break;
      case "entrypoint":
        ctx.setEntrypoint(argv);
        break;
      default:
        field satisfies never;
    }
  }
  applyAuthoredProcessFields(ctx, ["user", "workingDirectory"]);
  for (const [key, value] of Object.entries(service.providers ?? {})) ctx.addExtension(key, value);
};

export const composeServiceFeature: ServiceFeatureDefinition = {
  id: COMPOSE_FEATURE_ID,
  priority: COMPOSE_FEATURE_PRIORITY,
  apply: serviceFeatureApply(COMPOSE_FEATURE_ID, `${COMPOSE_FEATURE_ID} failed to apply`, applyCompose),
};

export const composeServiceType: ServiceType = {
  id: "compose",
  name: "compose",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337",
      normalizedConfig: { ...input.service, type: "compose" },
      features: [{ id: COMPOSE_FEATURE_ID }, { id: "lando.app-mount", config: { target: APP_MOUNT_TARGET } }],
    }),
};
