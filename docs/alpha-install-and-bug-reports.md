# Alpha install and bug reports

This Alpha supports two install paths:

- **Linux x64 binary:** download the dev prerelease artifact and the matching `SHA256SUMS` file from the GitHub prerelease.
- **npm dev install:** install the current Alpha package on Linux/macOS with `npm install @lando/core@dev`.

Windows binaries are deferred. macOS users should use the npm `dev` install path until macOS binary promotion lands in Beta.

## Verify the Linux x64 dev prerelease binary

Download both files into the same directory, then verify the checksum before running the binary:

```bash
sha256sum -c SHA256SUMS
chmod +x lando
./lando --version
```

The checksum command must report `lando: OK`. If it does not, delete the binary and `SHA256SUMS`, then download them again from the same dev prerelease.

## Verify an npm dev install

```bash
npm install @lando/core@dev
npx lando --version
```

Use this path on Linux or macOS when you want the npm package instead of the Linux x64 binary.

## Bug report checklist

Before filing an Alpha bug, run diagnostics and include the output:

```bash
lando doctor
```

Include these artifacts when available:

- The command you ran, its full stdout/stderr, and its exit code.
- `lando doctor` output.
- Any diagnostic `logsDir` and `cacheDir` paths printed in the failure report.
- The install path you used: Linux x64 dev prerelease binary or `npm install @lando/core@dev`.
- Host details: operating system, architecture, Bun version, and provider runtime details when the bug involves setup/start/stop/destroy.

Do not paste secrets or credentials. Lando redacts known secret-shaped values in its own diagnostics, but shell transcripts and copied logs can still contain project-specific sensitive data.
