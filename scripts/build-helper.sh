#!/bin/sh
# Compiles the PhotoKit helper with an embedded Info.plist (the Photos usage string).
set -e
cd "$(dirname "$0")/.."
mkdir -p build
cat > build/helper-Info.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.olevasyliev.seedguard.photos-helper</string>
  <key>NSPhotoLibraryUsageDescription</key><string>Seed Guard reads the text in your screenshots on this Mac to find recovery phrases and keys. Nothing is sent anywhere.</string>
</dict></plist>
EOF
swiftc -O helper/photos-helper.swift -o build/photos-helper -framework Photos -framework AppKit \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker build/helper-Info.plist
codesign --force -s - build/photos-helper
echo "built build/photos-helper"
