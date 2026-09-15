---
title: PHP base images
description: How Lando's generated PHP base image Dockerfiles are built and why stock PHP service plans still use upstream images.
---

# PHP base images

`images/php/<line>/Dockerfile` is generated from the same exact Composer checksum, Debian package pins, and extension inventory used by stock PHP service plans. The publishing workflow makes these definitions available for later adoption but runtime manifests intentionally continue to use upstream PHP images in this change.

PHP 8.6 is in that generated set. Official Hub currently publishes 8.6 as RC bookworm tags, so `images/php/8.6/Dockerfile` starts from `php:8.6-rc-apache-bookworm`. The generated image still installs only `gd`, `intl`, `mbstring`, `opcache`, `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite`, and `zip`. It does not install xdebug, redis, or apcu.

A follow-up can resolve each published image to its registry digest, record those digests in a committed manifest, and switch stock PHP plans to the digest-pinned Lando bases. That removes the remaining upstream-base and transitive-apt mutability documented beside the current build steps.
