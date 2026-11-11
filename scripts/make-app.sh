#!/bin/sh
# Wraps the dev tree in "build/Seed Guard.app" so macOS asks for Notes and Photos access in Seed Guard's name.
# The bundle loads src/ from this folder, so code changes need no rebuild; only Info.plist changes do.
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)
# It must live off iCloud Drive: the Desktop adds file-provider attributes that break code signing. Pass a folder, e.g. ~/Applications.
APP="${1:?usage: make-app.sh <folder off iCloud>}/Seed Guard.app"
[ -x build/photos-helper ] || sh scripts/build-helper.sh
# Electron 44 fetches its binary on first use, not on npm install: a fresh clone has no dist/ yet.
node node_modules/electron/install.js
rm -rf "$APP"
cp -R node_modules/electron/dist/Electron.app "$APP"
PL="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Seed Guard" -c "Set :CFBundleDisplayName Seed Guard" \
  -c "Set :CFBundleIdentifier com.olevasyliev.seedguard" "$PL"
/usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryUsageDescription string Seed Guard reads the text in your screenshots on this Mac to find recovery phrases and keys. Nothing is sent anywhere." "$PL" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSAppleEventsUsageDescription" "$PL" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string Seed Guard reads your notes through the Notes app and checks them on this Mac. Nothing is sent anywhere." "$PL"
mkdir -p "$APP/Contents/Resources/app"
printf '{ "name": "seed-guard", "productName": "Seed Guard", "type": "module", "main": "index.mjs" }\n' > "$APP/Contents/Resources/app/package.json"
printf "await import('%s');\n" "file://$ROOT/src/main.mjs" > "$APP/Contents/Resources/app/index.mjs"
rm -f "$APP/Contents/Resources/default_app.asar"
xattr -cr "$APP" # Desktop is iCloud-synced: Finder info and provenance attributes break the signature
codesign --force --deep -s - "$APP"
codesign --force -s - --identifier com.olevasyliev.seedguard "$APP"
codesign --verify --deep --strict "$APP"
echo "built $APP"
