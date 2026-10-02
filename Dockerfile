FROM rust:1-bookworm AS build
WORKDIR /src

# Parallelism for rustc. Override with --build-arg CARGO_BUILD_JOBS=<n>.
ARG CARGO_BUILD_JOBS=4
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS}

# Compile every dependency in a layer that only invalidates when the manifest changes. Without this,
# the `COPY server/src` below would invalidate the cache and rebuild the entire dependency graph
# (including aws-lc-sys, the slowest crate) on every source edit.
COPY server/Cargo.toml server/Cargo.lock server/
RUN mkdir -p server/src \
    && printf 'fn main() {}\n' > server/src/main.rs \
    && cargo build --release --locked --manifest-path server/Cargo.toml \
    && rm -rf server/src

# Only our crate is rebuilt after this point. The stub binary and its fingerprints must be removed
# explicitly: cargo decides freshness from source mtimes, and Docker restores the context's original
# mtimes, so a plain `cargo build` here would wrongly reuse the empty `fn main() {}` binary.
COPY server/src server/src
RUN rm -rf server/target/release/flax3d-server server/target/release/deps/flax3d_server-* \
    && find server/src -name '*.rs' -exec touch {} + \
    && cargo build --release --locked --manifest-path server/Cargo.toml

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