import { splitComposeCommand } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { serviceCursor } from "./claims.ts";
import { CAPABILITY_FRAGILE_KEYS, COMPOSE_KEY_RENAMES, dispositionOf } from "./compose-disposition-of.ts";
import type { Lando3Path } from "./contract.ts";
import { type AssignmentPolicy, lowerAssignments } from "./environment.ts";
import { withoutHostAlias, withoutHostIpVariable } from "./host-reachability.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  hasPlainObjectPrototype,
} from "./lowering-contract.ts";
import {
  needsReviewServiceKey,
  rejectedComposeKey,
  rewrittenServiceKey,
  unsupportedServiceKey,
} from "./service-diagnostics.ts";

export interface ComposeFieldOptions {
  readonly basePath: Lando3Path;
}

export const lowerComposeFields = (
  value: unknown,
  ctx: ServiceLoweringContext,
  options: ComposeFieldOptions,
): LoweringPatch => {
  const cursor = serviceCursor(value, ctx, options.basePath);
  cursor.take(options.basePath);
  const fields = new Map<string, unknown>();
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let blocked = false;
  const drop = (relative: Lando3Path): void => {
    diagnostics.push(
      cursor.dropTree(
        relative,
        "This Compose field or value has no supported Lando 4 representation.",
        "Set an explicit supported value in the generated service before starting it.",
      ),
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
    cursor.acceptNoOp(relative);
    diagnostics.push(rejectedComposeKey({ ctx, relative, key }));
    blocked = true;
  };
  const assignments = (input: unknown, relative: Lando3Path, policy: AssignmentPolicy) => {
    const result = lowerAssignments(input, { ctx: { ...ctx, cursor }, relative }, policy);
    diagnostics.push(...result.diagnostics);
    return result.entries;
  };

  if (!hasPlainObjectPrototype(value)) {
    drop(options.basePath);
    return { patch: {}, diagnostics };
  }
  for (const [key, authored] of Object.entries(value)) {
    const relative = [...options.basePath, key];
    const input = key === "extra_hosts" ? withoutHostAlias(authored, ctx, relative, diagnostics) : authored;
    if (input === undefined) continue;
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
    if ((key === "command" || key === "entrypoint") && typeof input === "string") {
      const split = splitComposeCommand(input);
      if (split === undefined) {
        diagnostics.push(
          unsupportedServiceKey({
            ctx,
            relative,
            message: `Compose ${key} has malformed shell-word syntax and cannot be converted.`,
            remediation:
              "Balance quotes and escapes, or supply an explicit argument list before translating.",
          }),
        );
        blocked = true;
        continue;
      }
      output = split.argv;
      diagnostics.push(
        split.truncated
          ? needsReviewServiceKey({
              ctx,
              relative,
              message: `Compose ${key} stops at an unquoted shell operator, so only the arguments before it were kept; the rest never ran.`,
              remediation:
                "To run the whole script, replace the argument list with an explicit shell, such as [sh, -c, <script>].",
            })
          : rewrittenServiceKey({
              ctx,
              relative,
              message: `Split scalar Compose ${key} into arguments to preserve execution without a shell.`,
              remediation: "Keep the explicit argument list to preserve Compose execution without a shell.",
            }),
      );
    } else if (key === "environment") {
      output = withoutHostIpVariable(assignments(input, relative, "environment"), ctx, diagnostics);
    } else if (key === "labels") {
      output = Object.fromEntries(
        assignments(input, relative, "labels").map(({ name, value }) => [name, value]),
      );
    } else if (key === "build") {
      cursor.take(relative);
      if (typeof input === "string") {
        output = { context: input };
        rewrite(relative, "build.context");
      } else if (hasPlainObjectPrototype(input)) {
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
              if (buildKey !== "args") cursor.mapTo(path);
              build.set(
                buildKey === "dockerfile_inline" ? "dockerfileInline" : buildKey,
                buildKey === "args"
                  ? Object.fromEntries(
                      assignments(entry, path, "build-args").map(({ name, value }) => [name, value]),
                    )
                  : entry,
              );
              break;
            case "preserved":
            case "unknown":
              if (buildKey === "dockerfileInline") {
                cursor.mapTo(path);
                build.set(buildKey, entry);
              } else drop(path);
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
    } else if (key === "networks" && hasPlainObjectPrototype(input)) {
      for (const [network, attachment] of Object.entries(input)) {
        if (!hasPlainObjectPrototype(attachment)) continue;
        for (const nestedKey of Object.keys(attachment)) {
          const dotted = `networks.*.${nestedKey}`;
          if (dispositionOf(dotted) === "rejected") reject(dotted, [...relative, network, nestedKey]);
        }
      }
    } else if ((key === "volumes" || key === "ports") && Array.isArray(input)) {
      if (key === "ports") {
        output = input.map((entry: unknown, index) => {
          if (typeof entry === "string") {
            const random = /^(?:(.+):)?0:(\d+(?:-\d+)?(?:\/(?:tcp|udp))?)$/.exec(entry);
            if (random === null) return entry;
            rewrite([...relative, index], "ports with an omitted random host port");
            return random[1] === undefined ? random[2] : `${random[1]}::${random[2]}`;
          }
          if (hasPlainObjectPrototype(entry) && (entry.published === 0 || entry.published === "0")) {
            rewrite([...relative, index, "published"], "ports with an omitted random host port");
            return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "published"));
          }
          return entry;
        });
      }
      input.forEach((entry: unknown, index) => {
        if (!hasPlainObjectPrototype(entry)) return;
        for (const nestedKey of Object.keys(entry)) {
          const dotted = `${key}.${nestedKey}`;
          if (dispositionOf(dotted) === "rejected") reject(dotted, [...relative, index, nestedKey]);
        }
      });
    }
    const target = Object.hasOwn(COMPOSE_KEY_RENAMES, key) ? COMPOSE_KEY_RENAMES[key] : undefined;
    if (!["build", "environment", "labels"].includes(key)) cursor.mapTo(relative);
    cursor.take(relative);
    fields.set(target ?? key, output);
  }
  return {
    patch: Object.fromEntries(fields),
    claims: cursor.claims,
    diagnostics,
    ...(blocked ? { blocked: true as const } : {}),
  };
};
