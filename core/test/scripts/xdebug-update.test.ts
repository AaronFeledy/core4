import { expect, test } from "bun:test";
import { type XdebugFetch, refreshXdebugPins } from "../../../scripts/update-xdebug.ts";
import { type XdebugPins, parseXdebugPhpRange, xdebugTarballUrl } from "../../../scripts/xdebug-pins.ts";

const phpRangeXml = (min: string, max: string) =>
  `<dependencies><required><php><min>${min}</min><max>${max}</max></php></required></dependencies>`;

const tarball = (min: string, max: string) =>
  new Bun.Archive(
    { "package.xml": `<package>${phpRangeXml(min, max)}</package>` },
    { compress: "gzip" },
  ).blob();

const empty: XdebugPins = { schemaVersion: 1, releases: {} };

test("chooses newest compatible stable first despite GitHub prerelease flags, then newest prerelease", async () => {
  const releases = [
    { tag_name: "3.8.0RC2", prerelease: false },
    { tag_name: "3.6.0", prerelease: true },
    { tag_name: "3.7.0", prerelease: false },
    { tag_name: "3.8.0RC10", prerelease: false },
    { tag_name: "3.5.0", prerelease: false },
    { tag_name: "4.0.0", prerelease: false },
    { tag_name: "3.x-dev", prerelease: false },
  ];
  const assets = new Map([
    [xdebugTarballUrl("3.8.0RC2"), await tarball("8.1.0", "8.6.99")],
    [xdebugTarballUrl("3.8.0RC10"), await tarball("8.1.0", "8.6.99")],
    [xdebugTarballUrl("3.7.0"), await tarball("8.2.1", "8.5.99")],
    [xdebugTarballUrl("3.6.0"), await tarball("8.1.0", "8.5.0")],
    [xdebugTarballUrl("3.5.0"), await tarball("8.1.0", "8.5.99")],
  ]);
  const request: XdebugFetch = async (url) =>
    url.startsWith("https://api.github.com/")
      ? Response.json(releases)
      : new Response(assets.get(url), { status: assets.has(url) ? 200 : 404 });

  const candidate = await refreshXdebugPins(empty, { request });

  expect(
    Object.fromEntries(Object.entries(candidate.releases).map(([php, pin]) => [php, pin.version])),
  ).toEqual({
    "8.1": "3.6.0",
    "8.2": "3.6.0",
    "8.3": "3.7.0",
    "8.4": "3.7.0",
    "8.5": "3.7.0",
    "8.6": "3.8.0RC10",
  });
  const selectedArchive = await assets.get(xdebugTarballUrl("3.7.0"))?.arrayBuffer();
  expect(candidate.releases["8.5"]).toEqual({
    phpMin: "8.2.1",
    phpMax: "8.5.99",
    version: "3.7.0",
    url: xdebugTarballUrl("3.7.0"),
    sha256: Bun.CryptoHasher.hash("sha256", selectedArchive ?? new ArrayBuffer(0), "hex"),
  });
});

test.each([true, false])(
  "stops after stable coverage; missing PHP 8.6 coverage fails (covered: %s)",
  async (covered) => {
    const asset = await tarball("8.1.0", covered ? "8.6.99" : "8.5.99");
    const request: XdebugFetch = async (url) => {
      if (url.startsWith("https://api.github.com/"))
        return Response.json([{ tag_name: "3.6.0" }, ...(covered ? [{ tag_name: "3.5.0" }] : [])]);
      return url === xdebugTarballUrl("3.6.0") ? new Response(asset) : new Response(null, { status: 404 });
    };

    if (covered) {
      expect((await refreshXdebugPins(empty, { request })).releases["8.6"]?.version).toBe("3.6.0");
    } else {
      await expect(refreshXdebugPins(empty, { request })).rejects.toThrow(
        /No compatible Xdebug release found for PHP 8\.6/,
      );
    }
  },
);

test("reads only the package's required PHP range, not optional dependencies or changelog releases", () => {
  const xml = `<package xmlns="http://pear.php.net/dtd/package-2.0">
    <dependencies><required><php><min>8.2.0</min><max>8.6.99</max></php></required>
      <optional><php><min>8.3.0</min><max>8.4.99</max></php></optional></dependencies>
    <changelog><release>${phpRangeXml("8.0.0", "8.5.99")}</release></changelog>
  </package>`;

  expect(parseXdebugPhpRange(xml)).toEqual({ phpMin: "8.2.0", phpMax: "8.6.99" });
  expect(() =>
    parseXdebugPhpRange(
      `<package><changelog><release>${phpRangeXml("8.0.0", "8.5.99")}</release></changelog></package>`,
    ),
  ).toThrow(/no valid dependencies\/required\/php/);
});

test.each([
  [200, "SHA-256 mismatch"],
  [404, "HTTP 404"],
] as const)(
  "rejects an unverifiable current pin before release discovery (HTTP %s)",
  async (status, reason) => {
    const url = xdebugTarballUrl("3.6.0");
    const previous: XdebugPins = {
      schemaVersion: 1,
      releases: {
        "8.6": { version: "3.6.0", url, sha256: "0".repeat(64), phpMin: "8.1.0", phpMax: "8.6.99" },
      },
    };
    const asset = await tarball("8.1.0", "8.6.99");
    const request: XdebugFetch = async (requestedUrl) => {
      if (requestedUrl !== url) throw new Error(`Unexpected fetch: ${requestedUrl}`);
      return new Response(asset, { status });
    };

    await expect(refreshXdebugPins(previous, { request })).rejects.toThrow(`PHP 8.6 pin ${url}: ${reason}`);
    await expect(refreshXdebugPins(empty, { request, baseline: previous })).rejects.toThrow(
      `PHP 8.6 pin ${url}: ${reason}`,
    );
  },
);

test("skips a broken candidate with a warning and still selects an older compatible release", async () => {
  const good = await tarball("8.1.0", "8.6.99");
  const request: XdebugFetch = async (url) => {
    if (url.startsWith("https://api.github.com/"))
      return Response.json([{ tag_name: "3.7.0" }, { tag_name: "3.6.0" }]);
    if (url === xdebugTarballUrl("3.7.0")) return new Response("not a tarball");
    return url === xdebugTarballUrl("3.6.0") ? new Response(good) : new Response(null, { status: 404 });
  };
  const warnings: string[] = [];

  const candidate = await refreshXdebugPins(empty, { request, warn: (message) => warnings.push(message) });

  expect(candidate.releases["8.6"]?.version).toBe("3.6.0");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(xdebugTarballUrl("3.7.0"));
});
