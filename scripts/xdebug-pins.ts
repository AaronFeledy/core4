import { Schema } from "effect";
import { SaxesParser } from "saxes";

export const XDEBUG_PINS_PATH = "plugins/service-lando/src/services/php-xdebug-pins.json";
export const xdebugTarballUrl = (version: string): string => `https://xdebug.org/files/xdebug-${version}.tgz`;

const releasePattern = /^3\.\d+\.\d+(?:(?:alpha|beta|RC)\d+)?$/iu;
const phpVersionPattern = /^\d+\.\d+\.\d+$/u;
export const isStableXdebug = (version: string): boolean => /^\d+\.\d+\.\d+$/u.test(version);

export class XdebugUpdateError extends Error {
  override readonly name = "XdebugUpdateError";
}

const XdebugPin = Schema.Struct({
  phpMax: Schema.String.check(Schema.isPattern(phpVersionPattern)),
  phpMin: Schema.String.check(Schema.isPattern(phpVersionPattern)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  url: Schema.String,
  version: Schema.String.check(Schema.isPattern(releasePattern)),
});
export type XdebugPin = typeof XdebugPin.Type;

export const XdebugPins = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  releases: Schema.Record(Schema.String.check(Schema.isPattern(/^\d+\.\d+$/u)), XdebugPin),
});
export type XdebugPins = typeof XdebugPins.Type;

export const readXdebugPins = async (path: string): Promise<XdebugPins> =>
  Schema.decodeUnknownSync(XdebugPins)(await Bun.file(path).json());

// Turn PECL's 3.x.yRC10 spelling into semver's 3.x.y-rc.10 for precedence.
const semver = (version: string): string => version.toLowerCase().replace(/(alpha|beta|rc)(\d+)$/u, "-$1.$2");

export const newestXdebugFirst = (tags: readonly string[]): string[] =>
  [...new Set(tags.filter((tag) => releasePattern.test(tag)))].sort((a, b) =>
    Bun.semver.order(semver(b), semver(a)),
  );

type PhpRange = Pick<XdebugPin, "phpMin" | "phpMax">;

export const parseXdebugPhpRange = (xml: string): PhpRange => {
  const parser = new SaxesParser({ xmlns: true });
  const path: string[] = [];
  let min = "";
  let max = "";
  const collect = (text: string) => {
    switch (path.join("/")) {
      case "package/dependencies/required/php/min":
        min += text;
        break;
      case "package/dependencies/required/php/max":
        max += text;
        break;
    }
  };
  parser.on("opentag", (tag) => {
    path.push(tag.local);
  });
  parser.on("closetag", () => {
    path.pop();
  });
  parser.on("text", collect);
  parser.on("cdata", collect);
  parser.write(xml).close();

  const phpMin = min.trim();
  const phpMax = max.trim();
  if (
    !phpVersionPattern.test(phpMin) ||
    !phpVersionPattern.test(phpMax) ||
    Bun.semver.order(phpMin, phpMax) > 0
  ) {
    throw new XdebugUpdateError("package.xml has no valid dependencies/required/php min and max range.");
  }
  return { phpMax, phpMin };
};

export const supportsPhp = ({ phpMin, phpMax }: PhpRange, line: string): boolean => {
  const version = `${line}.0`;
  return Bun.semver.order(phpMin, version) <= 0 && Bun.semver.order(version, phpMax) <= 0;
};

export const changedXdebugPins = (baseline: XdebugPins, candidate: XdebugPins) =>
  Object.keys(candidate.releases)
    .sort()
    .flatMap((php) => {
      const before = baseline.releases[php];
      const after = candidate.releases[php];
      return after === undefined || Bun.deepEquals(before, after) ? [] : [{ php, before, after }];
    });
