import { isAbsolute, resolve } from "node:path";
import {
  type LandofileDecodedOverlay,
  isLandofileOverride,
  isLandofileReset,
  isPlainRecord,
  override,
} from "@lando/sdk/landofile";

const mapValue = (value: unknown, transform: (plain: unknown) => unknown): unknown =>
  isLandofileReset(value)
    ? value
    : isLandofileOverride(value)
      ? override(mapValue(value.value, transform))
      : transform(value);

export const resolveToolingIncludeSourceRoots = (
  landofile: LandofileDecodedOverlay,
  sourceRoot: string,
  appRoot: string,
): LandofileDecodedOverlay => {
  const source = (value: unknown) =>
    mapValue(value, (plain) =>
      typeof plain !== "string" ||
      sourceRoot === appRoot ||
      isAbsolute(plain) ||
      /^(?:npm:|git@|github:|https?:\/\/)/u.test(plain)
        ? plain
        : resolve(sourceRoot, plain),
    );
  const includes = mapValue(landofile.includes, (plain) =>
    Array.isArray(plain)
      ? plain.map((entry) =>
          mapValue(entry, (item) =>
            isPlainRecord(item) && item.kind === "tooling" ? { ...item, source: source(item.source) } : item,
          ),
        )
      : plain,
  );
  const toolingIncludes = mapValue(landofile.toolingIncludes, (plain) =>
    isPlainRecord(plain)
      ? Object.fromEntries(
          Object.entries(plain).map(([namespace, entry]) => [
            namespace,
            mapValue(entry, (item) => (isPlainRecord(item) ? { ...item, file: source(item.file) } : item)),
          ]),
        )
      : plain,
  );
  return {
    ...landofile,
    ...(includes === undefined ? {} : { includes }),
    ...(toolingIncludes === undefined ? {} : { toolingIncludes }),
  } as LandofileDecodedOverlay;
};
