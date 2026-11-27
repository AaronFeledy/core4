import {
  DATA_VERSION_REFUSAL_MARKER,
  type ServiceDataVersion,
  type ServiceDataVersionFinding,
} from "./service-data-version.ts";

const dottedVersion = /^\d+(?:\.\d+)*$/u;
const validVersion = (value: string | undefined) =>
  value !== undefined && dottedVersion.test(value) ? value : undefined;

export const compareDataSeries = (a: string, b: string, depth: 1 | 2): -1 | 0 | 1 | undefined => {
  if (validVersion(a) === undefined || validVersion(b) === undefined) return undefined;
  const left = a.split(".").slice(0, depth).map(BigInt);
  const right = b.split(".").slice(0, depth).map(BigInt);
  if (left.length !== depth || right.length !== depth) return undefined;
  for (const [index, component] of left.entries()) {
    const other = right[index] ?? 0n;
    if (component !== other) return component < other ? -1 : 1;
  }
  return 0;
};

const compilePattern = (source: string, flags: "gu" | "u") => {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

export const parseDataVersionRecords = (
  contents: ReadonlyMap<string, string>,
  contract: ServiceDataVersion,
): string | undefined => {
  const series = contract.series;
  if (series === undefined) return undefined;
  let highest: string | undefined;
  for (const record of series.records) {
    const text = contents.get(record.path);
    const pattern = compilePattern(record.pattern, "gu");
    if (text === undefined || pattern === undefined) continue;
    for (const match of text.matchAll(pattern)) {
      const version = validVersion(match[1]);
      if (version === undefined || version.split(".").length < series.depth) continue;
      if (highest === undefined || compareDataSeries(version, highest, series.depth) === 1) highest = version;
    }
  }
  return highest?.split(".").slice(0, series.depth).join(".");
};

const markerPattern = new RegExp(
  `^${DATA_VERSION_REFUSAL_MARKER} data=(?<data>[\\d.]+) image=(?<image>[\\d.]+):`,
  "u",
);
const capturedVersion = (match: RegExpExecArray, side: "data" | "image") => {
  const major = match.groups?.[`${side}Major`];
  const minor = match.groups?.[`${side}Minor`];
  return validVersion(
    match.groups?.[side] ??
      (major === undefined || minor === undefined ? undefined : `${major}.${Number(minor)}`),
  );
};

export const classifyDataVersionRefusal = (
  contract: ServiceDataVersion,
  input: { readonly exitCode: number | undefined; readonly lines: readonly string[] },
): { readonly finding: ServiceDataVersionFinding; readonly hint?: string } | undefined => {
  if (input.exitCode === 0) return undefined;
  for (const line of input.lines) {
    const marker = markerPattern.exec(line);
    if (marker === null) continue;
    const dataVersion = capturedVersion(marker, "data");
    const imageVersion = capturedVersion(marker, "image");
    if (dataVersion !== undefined && imageVersion !== undefined) {
      return { finding: { direction: "downgrade", evidence: "guard", dataVersion, imageVersion } };
    }
  }
  for (const refusal of contract.refusals) {
    if (
      refusal.exitCodes !== undefined &&
      (input.exitCode === undefined || !refusal.exitCodes.includes(input.exitCode))
    )
      continue;
    const pattern = compilePattern(refusal.pattern, "u");
    if (pattern === undefined) continue;
    for (const line of input.lines) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const dataVersion = capturedVersion(match, "data");
      const imageVersion = capturedVersion(match, "image");
      const comparison =
        refusal.direction === "compare" && dataVersion !== undefined && imageVersion !== undefined
          ? compareDataSeries(dataVersion, imageVersion, contract.series?.depth ?? 1)
          : undefined;
      const direction =
        refusal.direction === "compare"
          ? comparison === 1
            ? "downgrade"
            : comparison === -1
              ? "upgrade"
              : "incompatible"
          : refusal.direction;
      return {
        finding: {
          direction,
          evidence: "server",
          ...(dataVersion === undefined ? {} : { dataVersion }),
          ...(imageVersion === undefined ? {} : { imageVersion }),
        },
        ...(refusal.hint === undefined ? {} : { hint: refusal.hint }),
      };
    }
  }
};
