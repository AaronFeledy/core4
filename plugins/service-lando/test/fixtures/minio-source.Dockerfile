# Test-only BYO fixture, never a Lando distribution or service default.
# Official server source: https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a
# /source retains upstream source, LICENSE and NOTICE in the resulting image.
FROM golang:1.23.12-alpine@sha256:383395b794dffa5b53012a212365d40c8e37109a626ca30d6151c8348d380b5f
WORKDIR /source
COPY minio-source.tar.gz /tmp/minio-source.tar.gz
RUN echo '45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841  /tmp/minio-source.tar.gz' | sha256sum -c - && tar -xzf /tmp/minio-source.tar.gz --strip-components=1
ENV GOTOOLCHAIN=go1.24.8 CGO_ENABLED=0 GOMAXPROCS=2
RUN go build -p 2 -trimpath -buildvcs=false -ldflags="-s -w" -o /usr/local/bin/minio .
COPY mc /usr/local/bin/mc
RUN echo '01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891  /usr/local/bin/mc' | sha256sum -c - && chmod 755 /usr/local/bin/mc
RUN minio --version && mc --version
CMD ["sleep", "infinity"]
