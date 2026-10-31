FROM golang:1.25.6@sha256:06d1251c59a75761ce4ebc8b299030576233d7437c886a68b43464bad62d4bb1 AS go
FROM rust:1.88.0-slim-bookworm@sha256:38bc5a86d998772d4aec2348656ed21438d20fcdce2795b56ca434cf21430d89 AS rust
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS bun

# This Noble base predates the signed APT snapshot used below.
FROM ubuntu:noble-20250127@sha256:72297848456d5d37d1262630108ab308d3e9ec7ed1c3286a32fe09856619a782 AS builder
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
ARG BUILDPLATFORM
ARG TARGETPLATFORM
ARG TARGETARCH
ARG BUNDLE_PLATFORM
RUN test "$BUILDPLATFORM" = "$TARGETPLATFORM" \
    && case "$BUNDLE_PLATFORM:$TARGETARCH" in linux-x64:amd64|linux-arm64:arm64) true;; *) false;; esac
COPY --from=bun /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY prerequisites.sh /tmp/prerequisites.sh
RUN bash /tmp/prerequisites.sh && rm /tmp/prerequisites.sh
COPY --from=go /usr/local/go /usr/local/go
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
    GOTOOLCHAIN=local TZ=UTC LANG=C.UTF-8
RUN --network=none case "$TARGETARCH" in \
      amd64) RUST_TRIPLE=x86_64-unknown-linux-gnu ;; \
      arm64) RUST_TRIPLE=aarch64-unknown-linux-gnu ;; \
      *) echo "Unsupported Rust target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && RUST_TOOLCHAIN="$RUSTUP_HOME/toolchains/1.88.0-$RUST_TRIPLE" \
    && test -x "$RUST_TOOLCHAIN/bin/rustc" \
    && test -x "$RUST_TOOLCHAIN/bin/cargo" \
    && ln -s "$RUST_TOOLCHAIN" /usr/local/rust-toolchain
ENV PATH=/usr/local/go/bin:/usr/local/rust-toolchain/bin:$PATH
RUN --network=none test "$(go env GOVERSION)" = go1.25.6 \
    && test "$(rustc --version | cut -d ' ' -f2)" = 1.88.0 \
    && test "$(cargo --version | cut -d ' ' -f2)" = 1.88.0 \
    && test "$(bun --version)" = 1.4.3
WORKDIR /build
COPY scripts/ scripts/
COPY plugins/ plugins/
ARG REPOSITORY
RUN bun scripts/entry.js "$BUNDLE_PLATFORM" "$REPOSITORY"

FROM scratch AS bundle
COPY --from=builder /out/ /
