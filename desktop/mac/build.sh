#!/bin/sh
# Builds dist/Stock Watcher.app, a native Mac app around the local server, and
# a zip of it for moving to another Mac. Run it again after changing anything:
# the app carries its own copy of the pages and server.py.
#
# Needs only the Command Line Tools (xcode-select --install), not Xcode.
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/dist"
APP="$OUT/Stock Watcher.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

# 1. The app itself, for Apple silicon and, where the installed tools can build
#    it, Intel too. Some Command Line Tools ship Apple-silicon libraries only;
#    then the app is built for this Mac's kind alone rather than not at all.
BUILT=""
for arch in arm64 x86_64; do
  if swiftc -O -target "$arch-apple-macos13.0" \
       -o "$WORK/app-$arch" "$ROOT/desktop/mac/StockWatcher.swift" 2>"$WORK/err-$arch"; then
    BUILT="$BUILT $WORK/app-$arch"
  else
    echo "note: skipped $arch — these build tools cannot target it" >&2
  fi
done
[ -n "$BUILT" ] || { cat "$WORK"/err-* >&2; exit 1; }
# shellcheck disable=SC2086
lipo -create $BUILT -output "$APP/Contents/MacOS/Stock Watcher"

# 2. The pages and the server, exactly as the website serves them.
cp "$ROOT/server.py" "$APP/Contents/Resources/app/"
cp -R "$ROOT/static" "$APP/Contents/Resources/app/static"

# 3. The icon, from the web app's own.
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/static/icon-512.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  if [ $s -lt 512 ]; then
    d=$((s * 2))
    sips -z $d $d "$ROOT/static/icon-512.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# 4. What macOS needs to know about it.
BUILD="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Stock Watcher</string>
  <key>CFBundleDisplayName</key><string>Stock Watcher</string>
  <key>CFBundleIdentifier</key><string>local.stockwatcher.app</string>
  <key>CFBundleExecutable</key><string>Stock Watcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.finance</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Runs the Stock Watcher pages and server locally.</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# 5. Signed ad hoc, which Apple silicon requires to run it at all, and zipped.
codesign --force --deep --sign - "$APP"
rm -f "$OUT/Stock-Watcher-mac.zip"
(cd "$OUT" && ditto -c -k --keepParent "Stock Watcher.app" "Stock-Watcher-mac.zip")

echo "Built $APP ($BUILD)"
echo "Zipped $OUT/Stock-Watcher-mac.zip"
