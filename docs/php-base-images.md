# PHP base images

`images/php/<line>/Dockerfile` is generated from the same exact Composer checksum, Debian package pins, and extension inventory used by stock PHP service plans. The publishing workflow makes these definitions available for later adoption but runtime manifests intentionally continue to use upstream PHP images in this change.

A follow-up can resolve each published image to its registry digest, record those digests in a committed manifest, and switch stock PHP plans to the digest-pinned Lando bases. That removes the remaining upstream-base and transitive-apt mutability documented beside the current build steps.
