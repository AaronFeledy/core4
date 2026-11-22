---
title: PHP base images
description: How Lando's generated PHP base image Dockerfiles are built and why stock PHP service plans still use upstream images.
---

# PHP base images

Stock PHP service plans still use upstream PHP images. The generated Lando base-image Dockerfiles remain available for future use.

Each `images/php/<line>/Dockerfile` uses the same Composer checksum, Debian package pins, and extension inventory as the stock PHP service plans. Here, `<line>` is the PHP version line, such as `8.6`.

Before adopting the Lando bases, build and publish the images, record their registry digests in a committed manifest, and update the stock PHP plans to use those digests. Until then, the upstream base image and transitive apt dependencies retain the mutability documented beside the current build steps.
