# Pinned real-world Lando 3 Landofiles

The YAML files in this directory are unmodified upstream test and development
Landofiles from the 36 MIT-licensed `lando/*` repositories recorded in
`manifest.json`. Each repository entry records its URL, exact commit, license,
copyright notice, original relative file paths, byte counts, and SHA-256 hashes.
The directory prefix is the upstream repository name, not part of the original
path. These fixtures are test-only and are not published in `@lando/lando3`.

The inventory contains every `.lando.yml` and `.lando.*.yml` outside
`node_modules` in the pinned checkouts. `exclusions` records non-Lando-3 files
with a reason. No files in this revision require exclusion: API-4 services in
Lando 3, including `core/examples/lando-v4`, are part of the Lando 3 runtime's
input format, not native Lando 4 Landofiles. Unrecognized layer basenames are
retained as evidence; production translation only consumes its supported layer
basenames. Directory groups in `documentSets` never inherit files from parent
directories. Referenced includes, environment files, scripts, and application
files are deliberately not supplied or fabricated.

## Refresh

For each repository entry, initialize a fresh checkout, add its recorded URL as
`origin`, fetch the recorded commit with `git fetch --depth=1 origin <commit>`,
and check out `FETCH_HEAD` detached. Verify the checked-out commit and MIT
license before copying. Copy matching Landofiles byte-for-byte, retaining the
repository prefix and original relative paths, and excluding `node_modules`.
Review non-Lando-3 files and record each exclusion and its reason. Recompute
each file's SHA-256 and byte count, and regroup files by original directory in
the manifest. Preserve line endings, whitespace, comments, and final newlines.
Do not add lint headers to vendored files. Run the corpus integrity, translation,
and core lint tests; review exact expectations individually rather than
automatically accepting new failures or silently retaining resolved ones.

## Upstream license

All 36 repositories carry the following notice and license at their recorded
commits. It applies to every vendored YAML file in this directory.

MIT License

Copyright (c) 2025 Lando Alliance

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
