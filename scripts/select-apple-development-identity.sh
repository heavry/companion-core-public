#!/bin/bash
set -euo pipefail

TEAM_OU="${1:-}"
if [ -z "$TEAM_OU" ]; then
  echo "usage: select-apple-development-identity.sh TEAM_OU" >&2
  exit 2
fi

SECURITY_BIN="${COMPANION_SECURITY_BIN:-/usr/bin/security}"
OPENSSL_BIN="${COMPANION_OPENSSL_BIN:-/usr/bin/openssl}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/companion-signing.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

VALID_SHA1="$($SECURITY_BIN find-identity -v -p codesigning 2>/dev/null \
  | awk '/Apple Development:/ && length($2) == 40 && $2 ~ /^[0-9A-Fa-f]+$/ { print toupper($2) }')"

if [ -z "$VALID_SHA1" ]; then
  echo "error: no valid Apple Development signing identities found" >&2
  exit 1
fi

CERTIFICATES="$TMP_DIR/apple-development-certificates.pem"
if ! "$SECURITY_BIN" find-certificate -a -c "Apple Development" -p > "$CERTIFICATES" 2>/dev/null; then
  echo "error: no Apple Development certificate metadata available" >&2
  exit 1
fi

awk -v dir="$TMP_DIR" '
  /-----BEGIN CERTIFICATE-----/ {
    count += 1
    output = sprintf("%s/certificate-%04d.pem", dir, count)
  }
  output != "" { print >> output }
  /-----END CERTIFICATE-----/ { close(output); output = "" }
' "$CERTIFICATES"

MATCHES=""
for certificate in "$TMP_DIR"/certificate-*.pem; do
  [ -f "$certificate" ] || continue
  CERT_SHA1="$($OPENSSL_BIN x509 -in "$certificate" -noout -fingerprint -sha1 2>/dev/null \
    | sed -n 's/^.*=//p' | tr -d ':' | tr '[:lower:]' '[:upper:]')"
  [ -n "$CERT_SHA1" ] || continue
  printf '%s\n' "$VALID_SHA1" | grep -qx "$CERT_SHA1" || continue

  CERT_SUBJECT="$($OPENSSL_BIN x509 -in "$certificate" -noout -subject -nameopt RFC2253 2>/dev/null || true)"
  CERT_OU="$(printf '%s\n' "$CERT_SUBJECT" | tr ',' '\n' | sed -n 's/^[[:space:]]*OU=//p' | head -n 1)"
  [ "$CERT_OU" = "$TEAM_OU" ] || continue

  if ! printf '%s\n' "$MATCHES" | grep -qx "$CERT_SHA1"; then
    MATCHES="${MATCHES}${MATCHES:+
}${CERT_SHA1}"
  fi
done

MATCH_COUNT="$(printf '%s\n' "$MATCHES" | awk 'NF { count += 1 } END { print count + 0 }')"
if [ "$MATCH_COUNT" -eq 0 ]; then
  echo "error: no valid Apple Development signing identity found for Team OU $TEAM_OU" >&2
  exit 1
fi
if [ "$MATCH_COUNT" -gt 1 ]; then
  MATCH_LIST="$(printf '%s\n' "$MATCHES" | awk 'NF' | paste -sd, -)"
  echo "error: multiple valid Apple Development signing identities found for Team OU $TEAM_OU (SHA-1: $MATCH_LIST)" >&2
  exit 1
fi

printf '%s\n' "$MATCHES"
