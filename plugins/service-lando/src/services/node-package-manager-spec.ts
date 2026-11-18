import { Schema } from "effect";
import { NodeInferenceError } from "./node-inference.ts";
import { NODE_PACKAGE_MANAGER_NAMES, type NodePackageManagerName } from "./node-package-manager.ts";

const isManagerName = Schema.is(Schema.Literals(NODE_PACKAGE_MANAGER_NAMES));
const PACKAGE_MANAGER_NAME_PATTERN = /^[a-z][a-z0-9._-]*$/u;
const INTEGRITY_HEX_LENGTH: Readonly<Record<string, number>> = {
  sha224: 56,
  sha256: 64,
  sha384: 96,
  sha512: 128,
};

const TOP_LEVEL_FIELD = ["packageManager"] as const;

export const invalidSpec = (sourcePath: string, exact: boolean): NodeInferenceError =>
  new NodeInferenceError(
    exact ? "The package manager must pin an exact version." : "Expected a valid package manager spec.",
    exact
      ? 'Use an exact "<name>@<version>" spec such as "yarn@4.5.3" or "pnpm@9.15.0+sha512.<hex>".'
      : 'Use a "<name>@<version or range>" spec such as "npm@10.9.2".',
    sourcePath,
    TOP_LEVEL_FIELD,
  );

export const requireManagerName = (
  sourcePath: string,
  field: readonly string[],
  name: string,
): NodePackageManagerName => {
  if (isManagerName(name)) return name;
  throw new NodeInferenceError(
    `The declaration names "${name}", which Lando does not recognize.`,
    "Use a supported manager (yarn, pnpm, npm, bun), remove the declaration, or use an explicit Node type with a custom image that provides the toolchain.",
    sourcePath,
    field,
  );
};

const parseIntegrity = (sourcePath: string, field: readonly string[], raw: string): string => {
  const match = /^(sha224|sha256|sha384|sha512)\.([0-9a-f]+)$/u.exec(raw);
  const [, algorithm = "", hex = ""] = match ?? [];
  if (INTEGRITY_HEX_LENGTH[algorithm] !== hex.length) {
    throw new NodeInferenceError(
      "The integrity hash is invalid.",
      "Use the correct algorithm and lowercase hex digest, or omit the integrity suffix.",
      sourcePath,
      field,
    );
  }
  return raw;
};

export const splitManagerVersion = (sourcePath: string, field: readonly string[], raw: string) => {
  const [version = "", build, ...extra] = raw.split("+");
  if (extra.length > 0) {
    throw new NodeInferenceError(
      "Expected at most one integrity suffix.",
      "Remove the extra suffix.",
      sourcePath,
      field,
    );
  }
  const integrity = build === undefined ? undefined : parseIntegrity(sourcePath, field, build);
  return { version, ...(integrity === undefined ? {} : { integrity }) };
};

export const splitSpec = (
  sourcePath: string,
  raw: unknown,
): { readonly name: NodePackageManagerName; readonly version: string; readonly integrity?: string } => {
  if (typeof raw !== "string") throw invalidSpec(sourcePath, true);
  const at = raw.indexOf("@");
  if (at <= 0 || at === raw.length - 1) throw invalidSpec(sourcePath, true);
  const name = raw.slice(0, at);
  if (!PACKAGE_MANAGER_NAME_PATTERN.test(name)) throw invalidSpec(sourcePath, true);
  const manager = requireManagerName(sourcePath, TOP_LEVEL_FIELD, name);
  return { name: manager, ...splitManagerVersion(sourcePath, TOP_LEVEL_FIELD, raw.slice(at + 1)) };
};
