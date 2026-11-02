import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { isLandofileOverride, isLandofileReset, isPlainRecord, override } from "@lando/sdk/landofile";

const mapValue = (value: unknown, transform: (plain: unknown) => unknown): unknown => {
  if (isLandofileReset(value)) return value;
  if (isLandofileOverride(value)) return override(mapValue(value.value, transform));
  return transform(value);
};

const mapRecord = (value: unknown, transform: (key: string, value: unknown) => unknown): unknown =>
  mapValue(value, (plain) =>
    isPlainRecord(plain)
      ? Object.fromEntries(Object.entries(plain).map(([key, entry]) => [key, transform(key, entry)]))
      : plain,
  );

const mapFields = (value: unknown, fields: Readonly<Record<string, (value: unknown) => unknown>>) =>
  mapRecord(value, (key, entry) => {
    const transform = Object.hasOwn(fields, key) ? fields[key] : undefined;
    return transform === undefined ? entry : transform(entry);
  });

const mapList = (value: unknown, transform: (value: unknown) => unknown): unknown =>
  mapValue(value, (plain) => (Array.isArray(plain) ? plain.map(transform) : plain));

export const composeIncludeDefaults = (
  document: Record<string, unknown>,
  localRoots?: { readonly appRoot: string; readonly sourceRoot: string },
): Record<string, unknown> => {
  const path = (value: unknown): unknown =>
    mapValue(value, (plain) => {
      if (
        localRoots === undefined ||
        typeof plain !== "string" ||
        plain === "" ||
        isAbsolute(plain) ||
        win32.isAbsolute(plain) ||
        plain.startsWith("~") ||
        // Build contexts may be URLs or scp-style Git references, not host paths.
        /^[a-z][a-z0-9+.-]*:|^[^/]+@[^:]+:/iu.test(plain)
      )
        return plain;
      const rebased = relative(localRoots.appRoot, resolve(localRoots.sourceRoot, plain))
        .split(sep)
        .join("/");
      // Keep bind sources visibly path-like; a bare name would become a named volume.
      if (rebased === "") return ".";
      return rebased.startsWith("../") ? rebased : `./${rebased}`;
    });
  const source = (value: unknown) => mapFields(value, { source: path });
  const shortSource = (spec: string): string => {
    const colon = spec.indexOf(":");
    if (colon < 0 || /^[A-Za-z]:[\\/]/u.test(spec)) return spec;
    return `${path(spec.slice(0, colon))}${spec.slice(colon)}`;
  };
  const volume = (value: unknown): unknown =>
    mapValue(value, (plain) => {
      if (typeof plain === "string") return plain.startsWith(".") ? shortSource(plain) : plain;
      if (!isPlainRecord(plain)) return plain;
      if (plain.type === "bind") return source(plain);
      if (plain.type !== undefined) return plain;
      return mapFields(plain, {
        source: (value) =>
          mapValue(value, (plain) =>
            typeof plain === "string" && plain.startsWith(".") ? path(plain) : plain,
          ),
      });
    });
  const envEntry = (value: unknown): unknown =>
    mapValue(value, (plain) => (isPlainRecord(plain) ? mapFields(plain, { path }) : path(plain)));
  const envFiles = (value: unknown) =>
    mapValue(value, (plain) => (Array.isArray(plain) ? plain.map(envEntry) : envEntry(plain)));
  const build = (value: unknown) =>
    mapValue(value, (plain) => {
      if (!isPlainRecord(plain)) return path(plain);
      const implicitContext =
        localRoots !== undefined &&
        plain.context === undefined &&
        ["dockerfile", "dockerfile_inline", "dockerfileInline", "args", "target"].some(
          (key) => plain[key] !== undefined,
        );
      return mapFields(implicitContext ? { ...plain, context: "." } : plain, { context: path });
    });
  const fileDefinitions = (value: unknown) =>
    mapRecord(value, (_key, entry) => mapFields(entry, { file: path }));
  const services = mapRecord(document.services, (_name, value) =>
    mapValue(value, (plain) =>
      isPlainRecord(plain)
        ? mapFields(
            { type: "compose", appMount: false, ...plain },
            {
              volumes: (value) => mapList(value, volume),
              env_file: envFiles,
              envFile: envFiles,
              build,
              devices: (value) =>
                mapList(value, (entry) =>
                  mapValue(entry, (plain) =>
                    typeof plain === "string" ? shortSource(plain) : source(plain),
                  ),
                ),
            },
          )
        : plain,
    ),
  );
  return {
    ...document,
    ...(services === undefined ? {} : { services }),
    ...(document.env_file === undefined ? {} : { env_file: envFiles(document.env_file) }),
    ...(document.configs === undefined ? {} : { configs: fileDefinitions(document.configs) }),
    ...(document.secrets === undefined ? {} : { secrets: fileDefinitions(document.secrets) }),
  };
};
