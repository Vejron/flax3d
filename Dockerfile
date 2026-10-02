FROM rust:1-bookworm AS build
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock server/
COPY server/src server/src
ENV CARGO_BUILD_JOBS=1
RUN cargo build --release --locked --manifest-path server/Cargo.toml

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /app flax3d \
    && mkdir -p /data/acme && chown -R flax3d:flax3d /data
WORKDIR /app
COPY --from=build /src/server/target/release/flax3d-server /app/flax3d-server
COPY dist /app/dist
USER flax3d
ENV FLAX3D_DIST=/app/dist FLAX3D_ACME_CACHE=/data/acme
EXPOSE 80/tcp 443/tcp 443/udp
CMD ["/app/flax3d-server"]