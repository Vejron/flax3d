# vue-project

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

This project replaces its workspace TypeScript package with [typescript-native-bridge](https://github.com/johnsoncodehk/typescript-native-bridge). Command-line tools use the bridge automatically. To use it in VS Code after installing dependencies, accept the prompt to use the workspace TypeScript version. If the prompt does not appear, run **TypeScript: Select TypeScript Version** and choose **Use Workspace Version**.

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) to make the TypeScript language service aware of `.vue` types.

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Run Unit Tests with [Vitest](https://vitest.dev/)

```sh
npm run test:unit
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```

## Multiplayer (local)

The Rust server requires a current Rust toolchain. For the wire protocol, transport mapping, and
message formats, see [NETWORKING.md](NETWORKING.md). Start the frontend and server in separate terminals from the repository root:

```sh
npm install
npm run dev
```

```sh
cargo run --manifest-path server/Cargo.toml
```

Open `http://localhost:5173/` in two browser tabs. The server binds to `127.0.0.1` on TCP/UDP 8698 for WebTransport and TCP 8699 for certificate metadata. It creates a fresh, short-lived self-signed certificate on each start; Vite proxies its public SHA-256 hash so the browser can verify the WebTransport connection without trusting a local CA. No key or certificate is committed. `2 ONLINE` indicates that both tabs are exchanging flight updates. The page remains playable alone if the server is down and retries automatically when it returns. Pose detection and webcam video stay on the local device.

For checks, run `cargo test --manifest-path server/Cargo.toml`, `cargo clippy --manifest-path server/Cargo.toml -- -D warnings`, `npm run test:unit -- --run`, and `npm run build`.

## Multiplayer (VPS)

Point the `A` record for `flax3d.intinor.uk` at the VPS (add `AAAA` only with working IPv6). Make TCP 80/443 and UDP 443 reachable in both provider and host firewalls. These ports must be available to Salvo: TCP 80 handles the ACME HTTP-01 challenge, TCP 443 serves the site over HTTPS, and UDP 443 carries HTTP/3 WebTransport. This deployment expects a Linux host, not a TCP-only reverse proxy in front of QUIC.

Build on the VPS (or transfer builds for its architecture), then launch from the repository root with persistent, writable ACME storage:

```sh
npm ci
npm run build
cargo build --release --manifest-path server/Cargo.toml
FLAX3D_DOMAIN=flax3d.intinor.uk FLAX3D_DIST="$PWD/dist" FLAX3D_ACME_CACHE=/var/lib/flax3d/acme server/target/release/flax3d-server
```

Test certificate issuance with `FLAX3D_ACME_STAGING=1` first, using **a separate ACME cache** from production. Staging certificates are not browser-trusted; remove the staging flag and switch to the production cache for the public site. Run the binary under a dedicated systemd user with write access to the ACME cache and `AmbientCapabilities=CAP_NET_BIND_SERVICE` for ports 80/443. Set the same environment variables in the service, set `WorkingDirectory` to the checkout, and use `Restart=on-failure`. Keep the cache across restarts and updates so certificate renewal continues; never expose the local hash endpoint or local certificate in production.

After deployment, open `https://flax3d.intinor.uk/` from another network in two supported browsers and verify the certificate, `2 ONLINE`, remote movement, join/leave, and reconnection after a service restart. To roll back, restore the previous frontend build and server binary together, then restart the service; retain the ACME cache. This first release is one public room for visual shared flight only: course progress stays local, and client-reported movement is not suitable for competitive scoring.

### Docker VPS deployment

Use `scripts/deploy.sh` to build the frontend and an `amd64` Docker image locally, transfer the image to the VPS, and deploy it while retaining the ACME volume. It defaults to `root@136.148.208.208`, `remote.intinor.uk`, and `/opt/flax3d`. Requirements on the development Mac are Docker Desktop, Node/npm, gzip, and SSH key access; the VPS needs Docker, curl, and UFW already allowing TCP 80/443 and UDP 443. The script checks SSH and Docker before building. It only replaces a prior container using a `flax3d:*` image, retaining the previous container under a unique rollback name. If HTTPS health checking fails, the script restores the previous container. Older rollback containers are pruned once a deploy is healthy, so at most one is retained; remove it manually after confirming the deployment is stable.

```sh
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

Override defaults through environment variables, for example `DEPLOY_DOMAIN=flax3d.intinor.uk ./scripts/deploy.sh` after adding that DNS record. `DEPLOY_HOST`, `DEPLOY_REMOTE_DIR`, `DEPLOY_PLATFORM`, `DEPLOY_HEALTH_TIMEOUT`, and `DEPLOY_CARGO_JOBS` are also supported. The script does not configure DNS or firewall rules.

Dependencies are compiled in their own Docker layer, so a source-only change rebuilds just the server crate rather than the whole dependency graph. `DEPLOY_CARGO_JOBS` (default 4) controls rustc parallelism for cold builds. Only one rollback container is kept: after a successful deploy, older `flax3d-rollback-*` containers are removed.

Salvo 1.0.0 needs an explicit Certon HTTP-01 solver. On first issuance Certon saves the new certificate before caching it for TLS; the server exits once and Docker reloads it automatically. Renewals update the in-memory cache. Preserve `/opt/flax3d/acme` on rebuilds and use `docker logs flax3d` to diagnose certificate errors. Use a separate volume and `FLAX3D_ACME_STAGING=1` when testing ACME staging; do not expose staging certificates as the public site.
