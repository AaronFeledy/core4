import { isLegacyTagged } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import type { Lando3Path } from "./contract.ts";
import type { ServiceLoweringContext } from "./lowering-contract.ts";
import { hasPlainObjectPrototype } from "./lowering-contract.ts";
import {
  droppedServiceKey,
  needsReviewServiceKey,
  rewrittenServiceKey,
  unsupportedServiceKey,
} from "./service-diagnostics.ts";
import { formatPath } from "./source.ts";

const RESIDUAL_REMEDIATION =
  "Configure this setting by hand in Lando 4, and report it so conversion can handle it.";

/** A residual means a lowerer gap; tests assert none occur. */
export const isResidualDiagnostic = (diagnostic: ConfigTranslateDiagnostic): boolean =>
  diagnostic.remediation === RESIDUAL_REMEDIATION;

/** Effective cells, never authored locations. Empty collections and tags are atomic. */
export const effectiveLeaves = (value: unknown, path: Lando3Path = []): readonly Lando3Path[] => {
  if (isLegacyTagged(value)) return [path];
  if (!Array.isArray(value) && !hasPlainObjectPrototype(value)) return [path];
  const children = Array.isArray(value)
    ? value.map((item: unknown, index) => [index, item] as const)
    : Object.entries(value);
  return children.length === 0
    ? [path]
    : children.flatMap(([key, child]) => effectiveLeaves(child, [...path, key]));
};

export class ClaimCursor {
  /** Mutable prefix-local ledger. It is never shared across effective views. */
  readonly claims: Lando3Path[] = [];
  constructor(
    readonly value: unknown,
    readonly ctx: ServiceLoweringContext,
  ) {}

  peek(path: Lando3Path): unknown {
    return path.reduce<unknown>((value, key) => {
      if (Array.isArray(value) && typeof key === "number") return value[key];
      return hasPlainObjectPrototype(value) ? value[String(key)] : undefined;
    }, this.value);
  }

  /** Reading a container does not consume its children. */
  take(path: Lando3Path): unknown {
    const value = this.peek(path);
    if (value !== undefined && effectiveLeaves(value).every((leaf) => leaf.length === 0))
      this.claims.push(path);
    return value;
  }

  /** Explicit whole-value transfer, for opaque values copied to an output field. */
  mapTo(path: Lando3Path): unknown {
    const value = this.peek(path);
    if (value !== undefined) this.claims.push(...effectiveLeaves(value, path));
    return value;
  }

  acceptNoOp(path: Lando3Path): void {
    this.mapTo(path);
  }

  dropTree(path: Lando3Path, message: string, remediation: string): ConfigTranslateDiagnostic {
    this.mapTo(path);
    return droppedServiceKey({ ctx: this.ctx, relative: path, message, remediation });
  }

  rejectTree(path: Lando3Path, message: string, remediation: string): ConfigTranslateDiagnostic {
    this.mapTo(path);
    return unsupportedServiceKey({ ctx: this.ctx, relative: path, message, remediation });
  }

  reviewTree(path: Lando3Path, message: string, remediation: string): ConfigTranslateDiagnostic {
    this.mapTo(path);
    return needsReviewServiceKey({ ctx: this.ctx, relative: path, message, remediation });
  }

  rewriteTree(path: Lando3Path, message: string, remediation: string): ConfigTranslateDiagnostic {
    this.mapTo(path);
    return rewrittenServiceKey({ ctx: this.ctx, relative: path, message, remediation });
  }

  /**
   * One `dropped` per effective leaf no lowerer claimed. `unknownRoots` are the
   * merged-coordinate roots the model already reported as unknown keys; a leaf
   * beneath one is covered by that report.
   */
  residuals(
    diagnostics: readonly ConfigTranslateDiagnostic[],
    unknownRoots: readonly Lando3Path[] = [],
  ): readonly ConfigTranslateDiagnostic[] {
    const claimed = new Set(this.claims.map((path) => JSON.stringify(path)));
    const reported = new Set(diagnostics.map(({ sourceId, keyPath }) => JSON.stringify([sourceId, keyPath])));
    return effectiveLeaves(this.value).flatMap((path) => {
      if (claimed.has(JSON.stringify(path))) return [];
      if (unknownRoots.some((root) => root.every((key, index) => key === path[index]))) return [];
      const diagnostic = droppedServiceKey({
        ctx: this.ctx,
        relative: path,
        message: `Conversion has no rule for ${formatPath([...this.ctx.keyPath, ...path])}, so it was left out.`,
        remediation: RESIDUAL_REMEDIATION,
      });
      return reported.has(JSON.stringify([diagnostic.sourceId, diagnostic.keyPath])) ? [] : [diagnostic];
    });
  }
}

export const serviceCursor = (
  value: unknown,
  ctx: ServiceLoweringContext,
  prefix: Lando3Path = [],
): ClaimCursor =>
  ctx.cursor ??
  new ClaimCursor(
    prefix.reduceRight<unknown>((child, key) => ({ [key]: child }), value),
    ctx,
  );
