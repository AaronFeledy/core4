---
title: PHP base images
description: How Lando's generated PHP base image Dockerfiles are built and why stock PHP service plans still use upstream images.
---

# PHP base images

`images/php/<line>/Dockerfile` is generated from the same Composer checksum, Debian package pins, and extension inventory used by stock PHP service plans. Those Dockerfiles stay in-tree for later adoption. Runtime manifests still use upstream PHP images.

PHP 8.6 is in that generated set. Official Hub currently publishes 8.6 as RC bookworm tags, so `images/php/8.6/Dockerfile` starts from `php:8.6-rc-apache-bookworm`.

A follow-up can build those Dockerfiles, pin each image by digest in a committed manifest, and switch stock PHP plans to those Lando bases. That removes the remaining upstream-base and transitive-apt mutability documented beside the current build steps.
