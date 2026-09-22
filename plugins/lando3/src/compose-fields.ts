import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { CAPABILITY_FRAGILE_KEYS, COMPOSE_KEY_RENAMES, dispositionOf } from "./compose-dispositions.ts";
import type { Lando3Path } from "./contract.ts";
import { type LoweringPatch, type ServiceLoweringContext, isPlainObject } from "./lowering-contract.ts";
import {
  droppedServiceKey,
  needsReviewServiceKey,
  rejectedComposeKey,
  rewrittenServiceKey,
} from "./service-diagnostics.ts";

export interface ComposeFieldOptions {
  readonly basePath: Lando3Path;
}

export const lowerComposeFields = (
  value: unknown,
  ctx: ServiceLoweringContext,
  options: ComposeFieldOptions,
): LoweringPatch => {
  const fields = new Map<string, unknown>();
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;
  const drop = (relative: Lando3Path): void => {
    diagnostics.push(
      droppedServiceKey({
        ctx,
        relative,
        message: "This Compose field or value has no supported Lando 4 representation.",
        remediation: "Set an explicit supported value in the generated service before starting it.",
      }),
    );
  };
  const rewrite = (relative: Lando3Path, target: string): void => {
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative,
        message: `Converted this Compose field to ${target}.`,
        remediation: `Review ${target} in the generated service.`,
      }),
    );
  };
  const reject = (key: string, relative: Lando3Path): void => {
    diagnostics.push(rejectedComposeKey({ ctx, relative, key }));
    blocked = true;
  };
  const stringMap = (input: unknown, relative: Lando3Path): Readonly<Record<string, string>> => {
    const entries = new Map<string, string>();
    if (Array.isArray(input)) {
      input.forEach((entry: unknown, index) => {
        const equals = typeof entry === "string" ? entry.indexOf("=") : -1;
        if (typeof entry === "string" && equals > 0) {
          entries.set(entry.slice(0, equals), entry.slice(equals + 1));
        } else {
          drop([...relative, index]);
        }
      });
    } else if (isPlainObject(input)) {
      for (const [key, entry] of Object.entries(input)) {
        if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
          entries.set(key, String(entry));
        } else {
          drop([...relative, key]);
        }
      }
    } else {
      drop(relative);
    }
    return Object.fromEntries(entries);
  };

  if (!isPlainObject(value)) {
    drop(options.basePath);
    return { patch: {}, diagnostics };
  }
  for (const [key, input] of Object.entries(value)) {
    const relative = [...options.basePath, key];
    const disposition = dispositionOf(key);
    switch (disposition) {
      case "rejected":
        reject(key, relative);
        continue;
      case "unknown":
        drop(relative);
        continue;
      case "preserved":
        diagnostics.push(
          needsReviewServiceKey({
            ctx,
            relative,
            message: `Compose field ${key} is preserved but only realized when the selected provider supports it.`,
            remediation: CAPABILITY_FRAGILE_KEYS.has(key)
              ? "No shipped provider realizes this field today. Configure an alternative before relying on it."
              : "Confirm the selected provider supports this field before relying on it.",
          }),
        );
        break;
      case "normalized": {
        const target = Object.hasOwn(COMPOSE_KEY_RENAMES, key) ? COMPOSE_KEY_RENAMES[key] : undefined;
        if (target !== undefined) rewrite(relative, target);
        break;
      }
      default:
        return disposition satisfies never;
    }

    let output = input;
    if (key === "environment" || key === "labels") {
      output = stringMap(input, relative);
    } else if (key === "build") {
      if (typeof input === "string") {
        output = { context: input };
        rewrite(relative, "build.context");
      } else if (isPlainObject(input)) {
        const build = new Map<string, unknown>();
        for (const [buildKey, entry] of Object.entries(input)) {
          const path = [...relative, buildKey];
          const dotted = `build.${buildKey}`;
          const buildDisposition = dispositionOf(dotted);
          switch (buildDisposition) {
            case "rejected":
              reject(dotted, path);
              break;
            case "normalized":
              build.set(
                buildKey === "dockerfile_inline" ? "dockerfileInline" : buildKey,
                buildKey === "args" ? stringMap(entry, path) : entry,
              );
              break;
            case "preserved":
            case "unknown":
              if (buildKey === "dockerfileInline") build.set(buildKey, entry);
              else drop(path);
              break;
            default:
              return buildDisposition satisfies never;
          }
        }
        output = Object.fromEntries(build);
      } else {
        drop(relative);
        continue;
      }
    } else if ((key === "volumes" || key === "ports") && Array.isArray(input)) {
      input.forEach((entry: unknown, index) => {
        if (!isPlainObject(entry)) return;
        for (const nestedKey of Object.keys(entry)) {
          const dotted = `${key}.${nestedKey}`;
          if (dispositionOf(dotted) === "rejected") reject(dotted, [...relative, index, nestedKey]);
        }
      });
    }
    const target = Object.hasOwn(COMPOSE_KEY_RENAMES, key) ? COMPOSE_KEY_RENAMES[key] : undefined;
    fields.set(target ?? key, output);
  }
  return { patch: Object.fromEntries(fields), diagnostics, ...(blocked ? { blocked: true as const } : {}) };
};
