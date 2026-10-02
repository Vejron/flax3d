#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_host="${DEPLOY_HOST:-root@136.148.208.208}"
domain="${DEPLOY_DOMAIN:-remote.intinor.uk}"
remote_dir="${DEPLOY_REMOTE_DIR:-/opt/flax3d}"
platform="${DEPLOY_PLATFORM:-linux/amd64}"
health_timeout="${DEPLOY_HEALTH_TIMEOUT:-180}"
release="$(date -u +%Y%m%dT%H%M%SZ)-$$"
image="flax3d:${release}"
rollback_name="flax3d-rollback-${release}"

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

[[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "invalid domain: $domain"
[[ "$remote_dir" == /* && "$remote_dir" != *..* ]] || die "remote directory must be an absolute safe path"
[[ "$health_timeout" =~ ^[0-9]+$ ]] || die "health timeout must be a number of seconds"

for tool in npm docker ssh gzip; do
  command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"
done

cd "$repo_root"

printf 'Checking SSH, Docker, and persistent ACME storage on %s...\n' "$deploy_host"
ssh "$deploy_host" bash -s -- "$remote_dir" <<'REMOTE_PREFLIGHT'
set -Eeuo pipefail
remote_dir="$1"
docker info >/dev/null
mkdir -p "$remote_dir/acme"
if [[ "$(stat -c '%u' "$remote_dir/acme")" != 10001 ]]; then
  chown 10001:10001 "$remote_dir/acme"
fi
REMOTE_PREFLIGHT

printf 'Building frontend...\n'
npm ci
npm run build

printf 'Building %s image...\n' "$image"
docker build --platform "$platform" --tag "$image" .

printf 'Transferring image to %s...\n' "$deploy_host"
docker save "$image" | gzip -1 | ssh "$deploy_host" 'bash -o pipefail -c "gzip -dc | docker load"'

printf 'Deploying https://%s/...\n' "$domain"
ssh "$deploy_host" bash -s -- "$image" "$domain" "$remote_dir" "$health_timeout" "$rollback_name" "$release" <<'REMOTE_DEPLOY'
set -Eeuo pipefail

image="$1"
domain="$2"
remote_dir="$3"
health_timeout="$4"
rollback_name="$5"
release="$6"
acme_dir="$remote_dir/acme"
certificate="$acme_dir/certificates/acme-v02.api.letsencrypt.org-directory/$domain/$domain.crt"
had_previous=0
deployment_complete=0

docker image inspect "$image" >/dev/null

if docker inspect flax3d >/dev/null 2>&1; then
  managed="$(docker inspect --format '{{ index .Config.Labels "com.intinor.flax3d.managed" }}' flax3d)"
  current_image="$(docker inspect --format '{{.Config.Image}}' flax3d)"
  [[ "$managed" == true || "$current_image" == flax3d:* ]] || {
    printf 'Refusing to replace an existing container named flax3d that is not a Flax3D image.\n' >&2
    exit 1
  }

  docker stop flax3d >/dev/null
  if ! docker rename flax3d "$rollback_name"; then
    docker start flax3d >/dev/null || true
    exit 1
  fi
  had_previous=1
fi

rollback() {
  current_release="$(docker inspect --format '{{ index .Config.Labels "com.intinor.flax3d.release" }}' flax3d 2>/dev/null || true)"
  if [[ "$current_release" == "$release" ]]; then
    docker rm -f flax3d >/dev/null 2>&1 || true
  fi
  if [[ "$had_previous" == 1 ]]; then
    docker rename "$rollback_name" flax3d
    docker start flax3d >/dev/null
    had_previous=0
    printf 'Restored previous Flax3D container.\n' >&2
  fi
}

on_exit() {
  if [[ "$deployment_complete" != 1 ]]; then
    rollback
  fi
}
trap on_exit EXIT

if ! docker run -d --name flax3d --restart unless-stopped \
  --label com.intinor.flax3d.managed=true \
  --label "com.intinor.flax3d.release=$release" \
  --cap-add NET_BIND_SERVICE \
  -e "FLAX3D_DOMAIN=$domain" \
  -v "$acme_dir:/data/acme" \
  -p 80:80/tcp -p 443:443/tcp -p 443:443/udp \
  "$image"; then
  exit 1
fi

deadline=$((SECONDS + health_timeout))
healthy=0

while (( SECONDS < deadline )); do
  state="$(docker inspect --format '{{.State.Status}}' flax3d 2>/dev/null || true)"

  if [[ "$state" == exited && ! -s "$certificate" ]]; then
    break
  fi

  if curl --fail --silent --show-error --max-time 5 \
    --resolve "$domain:443:127.0.0.1" "https://$domain/" -o /dev/null 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != 1 ]]; then
  docker logs --tail 80 flax3d >&2 || true
  exit 1
fi

deployment_complete=1
printf 'Deployment healthy: https://%s/\n' "$domain"
if [[ "$had_previous" == 1 ]]; then
  printf 'Previous container retained as %s.\n' "$rollback_name"
fi
REMOTE_DEPLOY