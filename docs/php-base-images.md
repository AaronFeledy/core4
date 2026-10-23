---
title: PHP base images
description: How Lando's generated PHP base image Dockerfiles are built and why stock PHP service plans still use upstream images.
---

# PHP base images

`images/php/<line>/Dockerfile` is generated from the same Composer checksum, Debian package pins, and extension inventory used by stock PHP service plans. The Dockerfiles remain in the repository, but no workflow publishes them. Stock PHP services still build from upstream PHP images.

The generated set includes PHP 8.6. Its Dockerfile, `images/php/8.6/Dockerfile`, uses the release-candidate base `php:8.6-rc-apache-bookworm`.

Adopting these images would require building and publishing them, recording their registry digests in a committed manifest, and switching stock PHP plans to those digest-pinned bases. The service would then reuse fixed image contents instead of rebuilding against an upstream tag and package repository that can change.
