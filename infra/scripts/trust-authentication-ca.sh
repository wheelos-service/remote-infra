#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: trust-authentication-ca.sh --ca PATH --url HTTPS_URL [--fingerprint SHA256]

Install a public PEM CA certificate in an Ubuntu system trust store and verify
the supplied HTTPS URL with the updated trust store. Root privileges are
required for install(1) and update-ca-certificates(8).
EOF
}

ca_file=
health_url=
expected_fingerprint=

while (($#)); do
  case "$1" in
    --ca)
      (($# >= 2)) || { usage; exit 2; }
      ca_file=$2
      shift 2
      ;;
    --url)
      (($# >= 2)) || { usage; exit 2; }
      health_url=$2
      shift 2
      ;;
    --fingerprint)
      (($# >= 2)) || { usage; exit 2; }
      expected_fingerprint=$2
      shift 2
      ;;
    -h|--help)
      usage >&2
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ -n "$ca_file" && -n "$health_url" ]] || { usage; exit 2; }
[[ "$health_url" == https://* ]] || { echo '--url must use HTTPS.' >&2; exit 2; }

if [[ ! -r /etc/os-release ]]; then
  echo 'Cannot identify the operating system: /etc/os-release is missing.' >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != ubuntu ]]; then
  echo "This script only supports Ubuntu (detected: ${ID:-unknown})." >&2
  exit 1
fi

[[ -r "$ca_file" ]] || { echo "CA file is not readable: $ca_file" >&2; exit 1; }
command -v openssl >/dev/null || { echo 'openssl is required.' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
command -v update-ca-certificates >/dev/null || { echo 'ca-certificates is required.' >&2; exit 1; }

fingerprint=$(openssl x509 -in "$ca_file" -noout \
  -fingerprint -sha256 2>/dev/null | sed 's/^[^=]*=//') || {
  echo "The CA file is not a valid PEM X.509 certificate: $ca_file" >&2
  exit 1
}
if [[ -n "$expected_fingerprint" && "$fingerprint" != "$expected_fingerprint" ]]; then
  echo "CA fingerprint mismatch: expected $expected_fingerprint, got $fingerprint" >&2
  exit 1
fi

destination="/usr/local/share/ca-certificates/teleop-${fingerprint//:/}.crt"
elevate=()
if ((EUID != 0)); then
  if ! sudo -v; then
    echo 'This step needs sudo privileges. Run the script from an interactive Ubuntu shell so sudo can authenticate.' >&2
    exit 1
  fi
  elevate=(sudo)
fi
"${elevate[@]}" install -o root -g root -m 0644 "$ca_file" "$destination"
"${elevate[@]}" update-ca-certificates >/dev/null
curl -q --fail --silent --show-error --proto '=https' \
  --cacert /etc/ssl/certs/ca-certificates.crt --connect-timeout 10 --max-time 30 \
  "$health_url" >/dev/null
printf 'Trusted CA %s (%s); HTTPS verification passed for %s\n' "$destination" "$fingerprint" "$health_url"
