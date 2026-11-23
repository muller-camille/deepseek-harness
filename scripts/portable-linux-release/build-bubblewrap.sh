#!/usr/bin/env bash
# Build the static bubblewrap that the portable Linux release ships as its command-sandbox runner.
#
# Usage: scripts/portable-linux-release/build-bubblewrap.sh <output-directory>
#
# Downloads the pinned upstream release, verifies its SHA-256, and compiles it for the host
# architecture inside a digest-pinned Alpine container. Static musl linking leaves the binary without
# glibc or libcap dependencies, so it runs on any Linux kernel that permits unprivileged user
# namespaces. Writes bwrap, COPYING, and SOURCE (upstream URL and digest) to the output directory.
# Requires docker. The container uses the host network and receives https_proxy and http_proxy; when
# SSL_CERT_FILE names a CA bundle, the container trusts it for package downloads.
set -euo pipefail

readonly bubblewrap_version=0.13.1
readonly bubblewrap_sha256=0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d
readonly bubblewrap_url="https://github.com/containers/bubblewrap/releases/download/v${bubblewrap_version}/bubblewrap-${bubblewrap_version}.tar.xz"
readonly bubblewrap_image=alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f

if (( $# != 1 )); then
  echo "Usage: $0 <output-directory>" >&2
  exit 2
fi
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p -- "$1"
output="$(cd -- "$1" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

# shellcheck source=../ci-verified-download.sh
source "$root/scripts/ci-verified-download.sh"
acquire_verified_archive "$bubblewrap_url" "$bubblewrap_sha256" "$work/bubblewrap.tar.xz"

docker_args=(--rm --network host -v "$work:/input:ro" -v "$output:/output"
  -e "OWNER=$(id -u):$(id -g)" -e "VERSION=$bubblewrap_version")
for name in https_proxy http_proxy HTTPS_PROXY HTTP_PROXY; do
  if [[ -n "${!name:-}" ]]; then docker_args+=(-e "$name=${!name}"); fi
done
if [[ -n "${SSL_CERT_FILE:-}" ]]; then
  docker_args+=(-v "$SSL_CERT_FILE:/etc/ssl/certs/ca-certificates.crt:ro")
fi

docker run "${docker_args[@]}" "$bubblewrap_image" sh -euc '
  apk add --no-cache build-base meson samurai pkgconf python3 libcap-dev libcap-static linux-headers >/dev/null
  tar -xJf /input/bubblewrap.tar.xz -C /tmp
  cd "/tmp/bubblewrap-$VERSION"
  meson setup build --prefer-static --default-library=static -Dc_link_args=-static \
    -Dselinux=disabled -Dman=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled >/dev/null
  meson compile -C build bwrap >/dev/null
  strip build/bwrap
  install -m 0755 build/bwrap /output/bwrap
  install -m 0644 COPYING /output/COPYING
  chown "$OWNER" /output/bwrap /output/COPYING
'
printf 'bubblewrap %s\n%s\nSHA-256 %s\n' "$bubblewrap_version" "$bubblewrap_url" "$bubblewrap_sha256" > "$output/SOURCE"
"$output/bwrap" --version
