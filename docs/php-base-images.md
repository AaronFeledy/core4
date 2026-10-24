---
title: PHP base images
description: How Lando's generated PHP base image Dockerfiles are built and why stock PHP service plans still use upstream images.
---

# PHP base images

Stock PHP service plans still use upstream PHP images, not the generated Lando base images. The publishing workflow prepares those base images for later adoption.

Each `images/php/<line>/Dockerfile` uses the same Composer checksum, Debian package pins, and extension inventory as the stock PHP service plans. Here, `<line>` is the PHP version line, such as `8.6`.

PHP 8.6 is in that generated set. Official Hub currently publishes 8.6 as RC bookworm tags, so `images/php/8.6/Dockerfile` starts from `php:8.6-rc-apache-bookworm`.

Adopting the Lando bases requires resolving each published image to its registry digest, recording those digests in a committed manifest, and changing stock PHP plans to use them. Until then, the upstream base image and transitive apt dependencies retain the mutability documented beside the current build steps.
