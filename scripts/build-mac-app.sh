#!/bin/bash
# 构建并严格签名 Companion.app artifact。Desktop 部署只允许由
# self-maintenance helper 的可回滚 transaction 执行。
set -euo pipefail
if [ "${1:-}" != "" ] && [ "${1:-}" != "--artifact-only" ]; then
  echo "usage: build-mac-app.sh [--artifact-only]" >&2
  exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../CompanionMac"
# 防止增量构建陈旧产物：清理 release 编译缓存后全新构建
rm -rf .build/arm64-apple-macosx/release
swift build -c release

APP=".build/release/Companion.app"
BIN=".build/release/CompanionMac"
RESOURCE_BUNDLE=".build/release/CompanionMac_CompanionKit.bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/"
# SwiftPM 资源 bundle（Persona 头像等）放入标准 Contents/Resources；
# App bundle 根目录只允许签名系统认可的标准内容。
AVATAR_RESOURCE="$RESOURCE_BUNDLE/Assets.xcassets/PersonaAvatar.imageset/PersonaAvatar.png"
if [ ! -f "$AVATAR_RESOURCE" ]; then
  echo "error: canonical PersonaAvatar resource is missing from the SwiftPM build" >&2
  exit 1
fi
rm -rf "$APP/Contents/Resources/CompanionMac_CompanionKit.bundle"
cp -R "$RESOURCE_BUNDLE" "$APP/Contents/Resources/CompanionMac_CompanionKit.bundle"
test -f "$APP/Contents/Resources/CompanionMac_CompanionKit.bundle/Assets.xcassets/PersonaAvatar.imageset/PersonaAvatar.png" || {
  echo "error: canonical PersonaAvatar resource was not copied into Companion.app" >&2
  exit 1
}
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>CompanionMac</string>
<key>CFBundleIdentifier</key><string>local.companion.mac</string>
<key>CFBundleName</key><string>Companion</string>
<key>CFBundleDisplayName</key><string>Companion</string>
<key>CFBundleShortVersionString</key><string>0.2.8.0</string>
<key>CFBundleVersion</key><string>0.2.8.0</string>
<key>NSMicrophoneUsageDescription</key><string>Companion 使用麦克风进行本机唤醒词检测和语音通话；音频只在本机处理，不会上传。</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHumanReadableCopyright</key><string>© 2026 Companion Core</string>
</dict></plist>
PLIST
# Resources 目录占位（未来放图标等资产）
touch "$APP/Contents/Resources/.keep"

# 使用稳定的开发者身份签名。SwiftPM 产出的 linker-signed/ad-hoc 签名以
# CDHash 作为 designated requirement，每次重建都会变化，无法持续访问同一
# Keychain 项目。可通过 COMPANION_CODE_SIGN_IDENTITY 显式覆盖身份；未设置时
# 仅选择证书 OU 与目标 Team 精确匹配的有效 Apple Development identity。
# 没有唯一、稳定的匹配身份时拒绝部署。
SIGNING_IDENTITY="${COMPANION_CODE_SIGN_IDENTITY:-}"
if [ -z "$SIGNING_IDENTITY" ]; then
  SIGNING_IDENTITY="$("$SCRIPT_DIR/select-apple-development-identity.sh" "852GWN26C8")"
fi
if [ -z "$SIGNING_IDENTITY" ]; then
  echo "error: no valid Apple Development signing identity found" >&2
  echo "set COMPANION_CODE_SIGN_IDENTITY to a stable codesigning identity" >&2
  exit 1
fi
xattr -cr "$APP"
ENTITLEMENTS="$SCRIPT_DIR/../CompanionMac/Companion.entitlements"
test -f "$ENTITLEMENTS" || { echo "error: Companion microphone entitlement file is missing" >&2; exit 1; }
codesign --force --deep --options runtime --timestamp=none --entitlements "$ENTITLEMENTS" --sign "$SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
SIGNING_DETAIL="$(codesign -dv --verbose=4 "$APP" 2>&1)"
echo "$SIGNING_DETAIL" | grep -q 'TeamIdentifier=852GWN26C8' || { echo "error: signing TeamIdentifier mismatch" >&2; exit 1; }
echo "$SIGNING_DETAIL" | grep -q 'Identifier=local.companion.mac' || { echo "error: signing bundle identifier mismatch" >&2; exit 1; }
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -q 'com.apple.security.device.audio-input' || { echo "error: signed app is missing microphone audio-input entitlement" >&2; exit 1; }
echo "artifact: $(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
