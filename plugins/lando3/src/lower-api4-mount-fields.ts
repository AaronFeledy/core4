import { isLegacyTagged } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import type { Lando3Path } from "./contract.ts";
import type { LoweringPatch, ServiceLoweringContext, V4Wire } from "./lowering-contract.ts";
import { hasPlainObjectPrototype } from "./lowering-contract.ts";
import { droppedServiceKey, rewrittenServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";

export const mountSourceKeys = ["source", "src"] as const;
export const mountTargetKeys = ["target", "destination", "dest"] as const;
export const mountOwnershipKeys = ["owner", "permissions", "perms", "user", "group"] as const;
export const mountOwnershipDiagnostics = (
  item: V4Wire,
  ctx: ServiceLoweringContext,
  relative: Lando3Path,
): readonly ConfigTranslateDiagnostic[] =>
  mountOwnershipKeys
    .filter((key) => Object.hasOwn(item, key))
    .map((key) =>
      droppedServiceKey({
        ctx,
        relative: [...relative, key],
        message:
          "Lando 4 mounts have no ownership settings; move Lando 3 chown/chmod behavior into an image build step.",
        remediation: "Set ownership in an image build step before mounting the directory in Lando 4.",
      }),
    );

export const lowerApi4StorageFields = (
  item: V4Wire & { readonly target: string },
  ctx: ServiceLoweringContext,
  relative: Lando3Path,
): LoweringPatch => {
  const scope = item.scope;
  let store = item.source;
  if (typeof store !== "string" || store.length === 0) {
    const prefix = scope === "app" || scope === "project" ? "" : `${ctx.serviceName}-`;
    const target = item.target
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    store = `${ctx.appSlug ?? "app"}-${prefix}${target}`;
  }
  const patch: Record<string, unknown> = { store, target: item.target };
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  if (scope === "app" || scope === "service") patch.scope = scope;
  else if (scope === "project") {
    patch.scope = "app";
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative: [...relative, "scope"],
        message: "Lando 3 project and app storage named the same volume; Lando 4 calls this scope app.",
        remediation: "Keep scope: app to preserve the app-shared volume.",
      }),
    );
  } else if (scope !== undefined)
    diagnostics.push(
      droppedServiceKey({
        ctx,
        relative: [...relative, "scope"],
        message:
          "Lando 3 fell back to service naming for this storage scope; Lando 4 uses the default service scope.",
        remediation:
          "Keep service-scoped storage, or explicitly choose scope: app to share data within the app.",
      }),
    );
  return { patch, diagnostics };
};

export const mountTagDiagnostics = (
  item: V4Wire,
  ctx: ServiceLoweringContext,
  relative: Lando3Path,
): readonly ConfigTranslateDiagnostic[] =>
  [...mountSourceKeys, ...mountTargetKeys]
    .filter((key) => isLegacyTagged(item[key]))
    .map((key) =>
      unsupportedServiceKey({
        ctx,
        relative: [...relative, key],
        message: "Tagged file references cannot be converted here.",
        remediation:
          "Replace the reference with an explicit path; referenced files are never read during conversion.",
      }),
    );

export const lowerApi4MountString = (
  text: string,
  ctx: ServiceLoweringContext,
  relative: Lando3Path,
): LoweringPatch => {
  const [source, target, mode, ...extra] = text.split(":");
  if (!source || !target || extra.length > 0)
    return {
      patch: {},
      diagnostics: [
        droppedServiceKey({
          ctx,
          relative,
          message: "Lando 3 mount strings need source:target with an optional mode; this entry was omitted.",
          remediation: "Declare a source:target bind with an optional :ro mode in Lando 4.",
        }),
      ],
    };
  return {
    patch: { source, target, ...(mode === "ro" ? { readOnly: true } : {}) },
    diagnostics:
      mode !== undefined && mode !== "ro" && mode !== "rw"
        ? [
            rewrittenServiceKey({
              ctx,
              relative,
              message: `Dropped the :${mode} flag; Lando 3 honored only :ro.`,
              remediation:
                "Keep the converted read-write bind, or set readOnly: true if the mount should be read-only.",
            }),
          ]
        : [],
  };
};

export const lowerApi4AppMount = (
  service: V4Wire,
  ctx: ServiceLoweringContext,
): {
  readonly mount?: V4Wire | false;
  readonly relative: Lando3Path;
  readonly diagnostics: readonly ConfigTranslateDiagnostic[];
} => {
  const keys = ["appMount", "appmount", "app-mount"] as const;
  const winner = keys.find((key) =>
    key === "app-mount" ? Object.hasOwn(service, key) : service[key] != null,
  );
  const relative = [winner ?? "app-mount"];
  const diagnostics = keys
    .filter((key) => Object.hasOwn(service, key) && key !== winner)
    .map((key) =>
      droppedServiceKey({
        ctx,
        relative: [key],
        message: `Lando 3 read ${winner ?? "the default app mount"} and ignored this alias.`,
        remediation: "Keep only appMount in the converted service to avoid conflicting app-mount aliases.",
      }),
    );
  if (winner === undefined)
    return {
      ...(ctx.topLevel.excludes.length > 0 || ctx.topLevel.includes.length > 0
        ? { mount: { target: "/app" } }
        : {}),
      relative,
      diagnostics,
    };
  const app = service[winner];
  if (
    app === null ||
    app === false ||
    app === 0 ||
    (typeof app === "string" && /^(0|false|off|disable|disabled)$/i.test(app))
  )
    return { mount: false, relative, diagnostics };
  if (hasPlainObjectPrototype(app)) return { mount: app, relative, diagnostics };
  if (typeof app === "string") {
    const normalized = lowerApi4MountString(`.:${app}`, ctx, relative);
    const { target, readOnly } = normalized.patch;
    return {
      ...(typeof target === "string"
        ? { mount: { target, ...(readOnly === true ? { read_only: true } : {}) } }
        : {}),
      relative,
      diagnostics: [...diagnostics, ...normalized.diagnostics],
    };
  }
  return {
    relative,
    diagnostics: [
      ...diagnostics,
      unsupportedServiceKey({
        ctx,
        relative,
        message: "Lando 3 could not mount this app-mount value; use a target path or false in Lando 4.",
        remediation: "Set appMount to a target path, an object with target, or false to disable it.",
      }),
    ],
  };
};
