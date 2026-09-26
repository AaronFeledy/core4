/**
 * Lando 3 `!load` / `!import` file tags as Lando 4 authoring expressions.
 *
 * Lando 3 read `path@type` from the tag, split on `@`, and decoded the file as
 * `string`, `json`, `yaml`, or `binary`; with no type the extension chose
 * json or yaml and everything else was read as text. Both tags behaved the
 * same. The emitted helper pipeline names that decoder explicitly, because
 * Lando 4 infers more formats from the extension (TOML, JSONC, ...) than
 * Lando 3 did. Nothing here opens, stats, or resolves the referenced file.
 *
 * `!import` becomes `load()` as well: Lando 4 `import()` only applies to a
 * service's certificate authorities, while Lando 3 treated both tags alike.
 */
import type { LegacyTagged } from "@lando/sdk/landofile";

export type TagLowering =
  | { readonly _tag: "expression"; readonly source: string; readonly message: string }
  | { readonly _tag: "unsupported"; readonly message: string; readonly remediation: string };

const DECODERS: Readonly<Record<string, string>> = {
  string: "text",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
};

const lando3Type = (file: string, hint: string | undefined): string => {
  if (hint !== undefined) return hint;
  const dot = file.lastIndexOf(".");
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return dot > slash ? file.slice(dot + 1) : "";
};

/** Characters that cannot sit inside a single-quoted expression literal as-is. */
const UNQUOTABLE = /['\\{}\n\r]/u;

export const lowerLegacyTag = (tagged: LegacyTagged): TagLowering => {
  if (tagged.tag !== "!load" && tagged.tag !== "!import") {
    return {
      _tag: "unsupported",
      message: `The YAML tag ${tagged.tag} has no Lando 4 equivalent.`,
      remediation: "Replace the tagged value with a plain value before converting.",
    };
  }
  if (typeof tagged.value !== "string" || tagged.value.trim() === "") {
    return {
      _tag: "unsupported",
      message: `${tagged.tag} must name a file path.`,
      remediation: "Replace the tagged value with a file path or a plain value before converting.",
    };
  }
  const [rawFile = "", rawHint] = tagged.value.split("@");
  const file = rawFile.trim();
  const hint = rawHint?.trim();
  const type = lando3Type(file, hint);
  if (type === "binary") {
    return {
      _tag: "unsupported",
      message: `${tagged.tag} ${tagged.value} reads the file as base64, which Lando 4 cannot place in a text value.`,
      remediation: "Inline the value or reference the file from a mount before converting.",
    };
  }
  if (file === "" || UNQUOTABLE.test(file)) {
    return {
      _tag: "unsupported",
      message: `${tagged.tag} ${tagged.value} is not a path Lando 4 can quote in load().`,
      remediation: "Rename the file to a plain relative path before converting.",
    };
  }
  if (/^(?:[\\/]|[a-z]:[\\/])/iu.test(file)) {
    return {
      _tag: "unsupported",
      message: `${tagged.tag} ${tagged.value} is an absolute path; Lando 4 loads files only from inside the app.`,
      remediation: "Move the file inside the app and reference it with an app-relative path.",
    };
  }
  const decoder = DECODERS[type] ?? "text";
  const importNote =
    tagged.tag === "!import"
      ? " Lando 4 import() only applies to certificate authorities, so it became load(), which reads the file the way Lando 3 !import did."
      : "";
  return {
    _tag: "expression",
    source: `{{ load('${file}') | ${decoder} }}`,
    message: `${tagged.tag} ${tagged.value} became a load() expression with the ${decoder} decoder; the file is read relative to the Landofile when the app loads.${importNote}`,
  };
};
