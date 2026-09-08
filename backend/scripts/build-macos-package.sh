#!/bin/bash
set -euo pipefail
# Produces an unsigned package. Does not install or register any service.
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS is required' >&2; exit 1; }
script_dir="$(cd "$(dirname "$0")" && pwd)"
backend_dir="$(cd "$script_dir/.." && pwd)"
package_version="${PACKAGE_VERSION:-0.1.0}"
package_output="${PACKAGE_OUTPUT:-$backend_dir/.data/packages}"
: "${NODE_BINARY:?NODE_BINARY is required; use an official portable Node macOS runtime}"
node_binary="$NODE_BINARY"
[[ "$node_binary" = /* && -x "$node_binary" ]] || { echo 'NODE_BINARY must be an absolute executable path' >&2; exit 1; }
# Homebrew Node links Homebrew libraries; copying that executable does not make a portable package.
non_system_dependencies="$(/usr/bin/otool -L "$node_binary" | /usr/bin/awk 'NR > 1 { line=$0; sub(/^[ \t]+/, "", line); sub(/ \(.*$/, "", line); if (line !~ /^\/usr\/lib\// && line !~ /^\/System\/Library\//) print line }')"
[[ -z "$non_system_dependencies" ]] || { echo "NODE_BINARY has non-system dynamic library dependencies; choose an official portable runtime:" >&2; echo "$non_system_dependencies" >&2; exit 1; }
node_architectures="$(/usr/bin/lipo -archs "$node_binary")"
build_architecture="$(uname -m)"
case " $node_architectures " in *" $build_architecture "*) ;; *) echo 'NODE_BINARY architecture must match the build machine and native modules' >&2; exit 1 ;; esac
"$node_binary" -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13)){console.error("Node 22.13+ is required");process.exit(1)}'
mkdir -p "$package_output"
if [[ -n "${PACKAGE_STAGE_DIR:-}" ]]; then
  [[ "$PACKAGE_STAGE_DIR" = /* && ! -e "$PACKAGE_STAGE_DIR" ]] || { echo 'PACKAGE_STAGE_DIR must be a new absolute directory' >&2; exit 1; }
  package_stage="$PACKAGE_STAGE_DIR"
  mkdir -p "$package_stage"
else
  package_stage="$(mktemp -d)"
  trap 'rm -rf "$package_stage"' EXIT
fi
npm --prefix "$backend_dir" run build
payload_dir="$package_stage/root/usr/local/lib/polyhedron-host"
mkdir -p "$payload_dir/bin"
cp "$node_binary" "$payload_dir/bin/node"
cp -R "$backend_dir/dist" "$backend_dir/scripts" "$backend_dir/node_modules" "$payload_dir/"
cp "$backend_dir/package.json" "$payload_dir/"
# Native modules and Node must match the target macOS architecture; this is not a universal build.
pkgbuild --root "$package_stage/root" --identifier com.polyhedron.host --version "$package_version" --install-location / "$package_output/PolyhedronHost-unsigned.pkg"
echo "Unsigned package: $package_output/PolyhedronHost-unsigned.pkg"
echo 'No credentials, host config, or launch agents are embedded. See scripts/README.md for signing and per-user setup.'
