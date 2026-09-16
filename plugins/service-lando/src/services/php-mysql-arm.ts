const packages = ["common", "libs", "client-plugins", "client"] as const;

const releases = {
  "8.0": {
    version: "8.0.46",
    hashes: [
      "299e8f7832cbfdb9acedac1a4c75b54c45201dde70386c496053bcf1a749318c",
      "f4570b6195fe7e3198412d58f371cc3729f4c0a0b9450a4ea6131e9423284c80",
      "34f3c41d32000f2c1b215247859f626614c8f637f7403f2b671a008d3af5dcb9",
      "c184f16ae7aaeba3032ef04a3fbcb059d421b21d10d5f907e212a8f6b29ae580",
    ],
  },
  "8.4": {
    version: "8.4.11",
    hashes: [
      "5d19b3bf89100fd19adb0f792880b226b4bce334fcc79b95556e47cb5be3709c",
      "9e5f814fdc380c461f4f9013b8408f0b947ce0cc84c14b3ab3498b74575df192",
      "923f1ad5c361d6b348cd31e8e61bea0bc1a61e9a510c1fb1a693f9e769e7d32b",
      "cfa858fe0325311ca7c54644ec1d839498fc2ad2205dbe9ecaecfe113bf83744",
    ],
  },
  "9.7": {
    version: "9.7.2",
    hashes: [
      "b8602e81a12d554f6b27ed4ee5cf11f7524634baa3fc4af7c1cc6ff87cb6be22",
      "b17ffcf8cd05dd89c95badb1b6397ffe86be117aa7231e210da7f11815505f71",
      "27396323ff0b788efc623bc4a9df055ea2136938f0273d84a80e25440d0181e2",
      "fdc782f9080d6b42715faa8530f48823a90a5b1f90f1ea354a4f67ebef311b0d",
    ],
  },
} as const;

export const phpMysqlArmSource = (series: string) => {
  if (series !== "8.0" && series !== "8.4" && series !== "9.7") {
    throw new RangeError(`Unsupported MySQL client version ${series}`);
  }
  const release = releases[series];
  const artifacts = release.hashes.map((sha256, index) => {
    const name = packages[index];
    const filename = `mysql-community-${name}-${release.version}-1.el9.aarch64.rpm`;
    return {
      package: `mysql-community-${name}`,
      filename,
      url: `https://repo.mysql.com/yum/mysql-${series}-community/el/9/aarch64/${filename}`,
      sha256,
    };
  });
  return {
    architecture: "arm64",
    kind: "rpm-payload",
    version: release.version,
    artifacts,
    command: [
      "set -eux",
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update",
      "apt-get install -y --no-install-recommends ca-certificates libarchive-tools libaio1 libnuma1 libncurses6 libtinfo6 libssl3 libstdc++6 zlib1g libgssapi-krb5-2",
      "work=$(mktemp -d) && export work",
      `trap 'rm -rf "$work"' EXIT`,
      ...artifacts.map(
        (artifact) =>
          `php -r 'if (copy("${artifact.url}", getenv("work") . "/${artifact.filename}") !== true) { exit(1); }'`,
      ),
      `printf '%s\\n' ${artifacts.map((artifact) => `"${artifact.sha256}  $work/${artifact.filename}"`).join(" ")} | sha256sum -c -`,
      'mkdir "$work/payload"',
      ...artifacts.map((artifact) => `bsdtar -xf "$work/${artifact.filename}" -C "$work/payload"`),
      'cp -a "$work/payload/usr/bin/"mysql* /usr/bin/',
      "mkdir -p /usr/lib64/mysql",
      'cp -a "$work/payload/usr/lib64/mysql/." /usr/lib64/mysql/',
      'cp -a "$work/payload/usr/share/." /usr/share/',
      `printf '%s\\n' /usr/lib64/mysql /usr/lib64/mysql/private > /etc/ld.so.conf.d/lando-mysql.conf`,
      "ldconfig",
      "rm -rf /var/lib/apt/lists/*",
    ].join(" && "),
  };
};
