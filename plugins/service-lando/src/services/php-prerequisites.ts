import type { ServiceBuildStepIntent } from "@lando/sdk/services";

export const PHP_COMPOSER_RELEASES = {
  "2.7.7": {
    version: "2.7.7",
    sha256: "aab940cd53d285a54c50465820a2080fcb7182a4ba1e5f795abfb10414a4b4be",
    url: "https://getcomposer.org/download/2.7.7/composer.phar",
  },
  "2.10.2": {
    version: "2.10.2",
    sha256: "5ee7125f8a30a34d246cefdc0bc85b8a783b28f2aec968994118512350d28027",
    url: "https://getcomposer.org/download/2.10.2/composer.phar",
  },
} as const;

export const PHP_COMPOSER_MAJORS = {
  "2": "2.10.2",
} as const;

export type PhpComposerRelease = (typeof PHP_COMPOSER_RELEASES)[keyof typeof PHP_COMPOSER_RELEASES];
export type PhpComposerExactVersion = keyof typeof PHP_COMPOSER_RELEASES;
export type PhpComposerMajor = keyof typeof PHP_COMPOSER_MAJORS;

export const PHP_COMPOSER: PhpComposerRelease = PHP_COMPOSER_RELEASES["2.10.2"];

export const PHP_APT_PACKAGE_PINS = {
  unzip: "6.0-28",
  "libfreetype6-dev": "2.12.1+dfsg-5+deb12u4",
  "libicu-dev": "72.1-3+deb12u1",
  "libjpeg62-turbo-dev": "1:2.1.5-2",
  "libpng-dev": "1.6.39-2+deb12u5",
  "libpq-dev": "15.19-0+deb12u1",
  "libzip-dev": "1.7.3-1+b1",
} as const;

export const PHP_COMMON_EXTENSIONS = [
  "gd",
  "intl",
  "mbstring",
  "opcache",
  "pdo_mysql",
  "pdo_pgsql",
  "pdo_sqlite",
  "zip",
] as const;

const PHP_EXTENSIONS_TO_BUILD = ["gd", "intl", "pdo_mysql", "pdo_pgsql", "zip"] as const;
const PHP_APT_MANIFEST_PATH = "/usr/local/share/lando/php-apt-manifest.txt";

const aptPackageArguments = Object.entries(PHP_APT_PACKAGE_PINS).map(
  ([name, version]) => `${name}=${version}`,
);

// Exact direct-package pins and the resolved dpkg manifest bound cold builds within Debian's
// retention window. The upstream php image and transitive apt closure remain mutable until the
// follow-up switches runtime plans to digest-pinned Lando PHP base images.
export const PHP_PREREQUISITES_COMMAND = [
  "set -eux",
  "apt-get update",
  `apt-get install -y --no-install-recommends ${aptPackageArguments.join(" ")}`,
  "docker-php-ext-configure gd --with-freetype --with-jpeg",
  `docker-php-ext-install -j\"$(nproc)\" ${PHP_EXTENSIONS_TO_BUILD.join(" ")}`,
  `mkdir -p ${PHP_APT_MANIFEST_PATH.slice(0, PHP_APT_MANIFEST_PATH.lastIndexOf("/"))}`,
  `dpkg-query -W -f='\${Package}=\${Version}\\n' | LC_ALL=C sort > ${PHP_APT_MANIFEST_PATH}`,
  "rm -rf /var/lib/apt/lists/*",
].join(" && ");

const isComposerMajor = (value: string): value is PhpComposerMajor =>
  Object.hasOwn(PHP_COMPOSER_MAJORS, value);

const isComposerExact = (value: string): value is PhpComposerExactVersion =>
  Object.hasOwn(PHP_COMPOSER_RELEASES, value);

const composerRemediation = `Set ${Object.keys(PHP_COMPOSER_MAJORS)
  .map((major) => `composer: "${major}"`)
  .join(", ")}, ${Object.keys(PHP_COMPOSER_RELEASES)
  .map((version) => `composer: "${version}"`)
  .join(", ")}, or composer: false.`;

export const composerCommandFor = (release: PhpComposerRelease): string =>
  [
    "set -eux",
    `php -r '$url = "${release.url}"; $target = "/tmp/composer.phar"; if (copy($url, $target) !== true) { exit(1); } $actual = hash_file("sha256", $target); if ($actual === false || !hash_equals("${release.sha256}", $actual)) { fwrite(STDERR, "Composer checksum mismatch\\n"); exit(1); }'`,
    "install -m 0755 /tmp/composer.phar /usr/local/bin/composer",
    "rm -f /tmp/composer.phar",
  ].join(" && ");

export const PHP_COMPOSER_COMMAND = composerCommandFor(PHP_COMPOSER);

export const resolvePhpComposer = (value: unknown): PhpComposerRelease | false => {
  if (value === undefined) return PHP_COMPOSER;
  if (value === false) return false;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Unsupported Composer version ${JSON.stringify(value)}. ${composerRemediation}`);
  }
  if (isComposerMajor(value)) {
    return PHP_COMPOSER_RELEASES[PHP_COMPOSER_MAJORS[value]];
  }
  if (isComposerExact(value)) {
    return PHP_COMPOSER_RELEASES[value];
  }
  throw new Error(`Unsupported Composer version "${value}". ${composerRemediation}`);
};

export const phpPrerequisiteBuildSteps = (
  composer: unknown = undefined,
): ReadonlyArray<ServiceBuildStepIntent> => {
  const prerequisites: ServiceBuildStepIntent = {
    id: "service-lando.php:prerequisites",
    phase: "build",
    command: PHP_PREREQUISITES_COMMAND,
    buildKeyInputs: {
      aptPackages: PHP_APT_PACKAGE_PINS,
      extensions: PHP_COMMON_EXTENSIONS,
    },
  };
  const release = resolvePhpComposer(composer);
  if (release === false) return [prerequisites];
  return [
    prerequisites,
    {
      id: "service-lando.php:composer",
      phase: "build",
      command: composerCommandFor(release),
      buildKeyInputs: { composer: release },
    },
  ];
};
