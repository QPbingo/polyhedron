#!/bin/bash
set -euo pipefail
# Explicit release action. Requires certificates in this user's Keychain and a notarytool profile.
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS is required' >&2; exit 1; }
: "${SIGNING_IDENTITY:?Set Developer ID Application identity}"
: "${PKG_SIGNING_IDENTITY:?Set Developer ID Installer identity}"
: "${NOTARY_PROFILE:?Set an existing notarytool Keychain profile}"
: "${PACKAGE_ROOT:?Set an absolute staged package root containing usr/local/lib/polyhedron-host}"
: "${SIGNED_PACKAGE:?Set an absolute output .pkg path}"
[[ "$PACKAGE_ROOT" = /* && "$SIGNED_PACKAGE" = /* ]] || { echo 'Paths must be absolute' >&2; exit 1; }
[[ -x "$PACKAGE_ROOT/usr/local/lib/polyhedron-host/bin/node" ]] || { echo 'Staged Node runtime is missing' >&2; exit 1; }
entitlements_file="$(mktemp)"
trap 'rm -f "$entitlements_file"' EXIT
cat > "$entitlements_file" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>
PLIST
# Sign each Mach-O before packaging. No ad-hoc signature or fake notarization fallback.
while IFS= read -r -d '' binary; do
  if /usr/bin/file "$binary" | /usr/bin/grep -q 'Mach-O'; then
    if [[ "$binary" == "$PACKAGE_ROOT/usr/local/lib/polyhedron-host/bin/node" ]]; then
      codesign --force --options runtime --entitlements "$entitlements_file" --timestamp --sign "$SIGNING_IDENTITY" "$binary"
    else
      codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$binary"
    fi
    codesign --verify --strict "$binary"
  fi
done < <(find "$PACKAGE_ROOT" -type f -print0)
pkgbuild --root "$PACKAGE_ROOT" --identifier com.polyhedron.host --version "${PACKAGE_VERSION:-0.1.0}" --install-location / --sign "$PKG_SIGNING_IDENTITY" "$SIGNED_PACKAGE"
pkgutil --check-signature "$SIGNED_PACKAGE"
xcrun notarytool submit "$SIGNED_PACKAGE" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$SIGNED_PACKAGE"
xcrun stapler validate "$SIGNED_PACKAGE"
spctl --assess --type install --verbose "$SIGNED_PACKAGE"
