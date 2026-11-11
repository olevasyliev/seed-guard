// Photos access for Seed Guard through PhotoKit. Pixels only leave this process as temp files the app deletes after OCR.
// Usage: photos-helper status | request | count <sinceISO> | export <sinceISO> <outDir> <maxSide>
// export prints one JSON line per screenshot written, then waits for a line on stdin ("next" or "stop").

import AppKit
import Foundation
import Photos

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func name(_ s: PHAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .limited: return "limited"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

// Demo mode (SEED_GUARD_ALBUM set by the app): a user album with this title replaces the Screenshots album.
let demoAlbum = ProcessInfo.processInfo.environment["SEED_GUARD_ALBUM"]

func source() -> PHAssetCollection? {
  if let demoAlbum {
    let byTitle = PHFetchOptions()
    byTitle.predicate = NSPredicate(format: "title == %@", demoAlbum)
    return PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: byTitle).firstObject
  }
  return PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .smartAlbumScreenshots, options: nil).firstObject
}

// The user-visible Screenshots smart album (or the demo album), newest first, optionally from a date on.
// Images only, whatever their subtype: a phone photo of a paper backup is not a screenshot.
func screenshots(since: Date?) -> PHFetchResult<PHAsset>? {
  guard let album = source() else { return nil }
  let opts = PHFetchOptions()
  var filters = [NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)]
  if let since { filters.append(NSPredicate(format: "creationDate >= %@", since as NSDate)) }
  opts.predicate = NSCompoundPredicate(andPredicateWithSubpredicates: filters)
  opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
  return PHAsset.fetchAssets(in: album, options: opts)
}

let iso = ISO8601DateFormatter()
let args = CommandLine.arguments
let since = args.count > 2 && args[2] != "all" ? iso.date(from: args[2]) : nil

switch args.count > 1 ? args[1] : "" {
case "status":
  emit(["status": name(PHPhotoLibrary.authorizationStatus(for: .readWrite))])

case "request":
  let done = DispatchSemaphore(value: 0)
  PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in
    emit(["status": name(s)])
    done.signal()
  }
  done.wait()

case "count":
  emit(["count": screenshots(since: since)?.count ?? 0])

case "export":
  guard args.count > 4, let maxSide = Double(args[4]), let assets = screenshots(since: since) else {
    emit(["error": "usage: export <sinceISO|all> <outDir> <maxSide>"]); exit(2)
  }
  let outDir = URL(fileURLWithPath: args[3])
  let opts = PHImageRequestOptions()
  opts.isSynchronous = true
  opts.deliveryMode = .highQualityFormat
  opts.resizeMode = .fast
  opts.isNetworkAccessAllowed = true // originals kept only in iCloud are fetched by Photos itself
  for i in 0..<assets.count {
    let asset = assets.object(at: i)
    let scale = min(1, maxSide / Double(max(asset.pixelWidth, asset.pixelHeight)))
    let size = CGSize(width: Double(asset.pixelWidth) * scale, height: Double(asset.pixelHeight) * scale)
    var line: [String: Any] = ["i": i, "total": assets.count, "id": asset.localIdentifier,
                               "date": asset.creationDate.map { iso.string(from: $0) } ?? NSNull()]
    var image: NSImage?
    PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: opts) { img, _ in image = img }
    if let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil),
       let jpg = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.9]) {
      let file = outDir.appendingPathComponent("shot-\(i).jpg")
      try? jpg.write(to: file, options: .atomic)
      line["path"] = file.path
    } else {
      line["error"] = "unavailable"
    }
    emit(line)
    guard let reply = readLine(), reply == "next" else { break }
  }
  emit(["done": true])

// Opaque ids of every image in the album (the demo album, or the one SEED_GUARD_ALBUM names): ground truth for a test.
case "ids":
  guard let assets = screenshots(since: nil) else { emit(["error": "no album"]); exit(2) }
  emit(["ids": (0..<assets.count).map { assets.object(at: $0).localIdentifier }])

// Counts only: how many screenshots Photos can hand over from this Mac, how many need iCloud, and whether a few
// iCloud-only ones download when network access is allowed.
case "probe":
  guard let assets = screenshots(since: since) else { emit(["error": "no album"]); exit(2) }
  var tally: [String: Int] = [:]
  var cloudOnly: [PHAsset] = []
  let maxSide = 1600.0 // the size export asks for: a small local preview is not enough
  for i in 0..<assets.count {
    let asset = assets.object(at: i)
    let scale = min(1, maxSide / Double(max(asset.pixelWidth, asset.pixelHeight)))
    let size = CGSize(width: Double(asset.pixelWidth) * scale, height: Double(asset.pixelHeight) * scale)
    let local = PHImageRequestOptions()
    local.isSynchronous = true
    local.deliveryMode = .highQualityFormat
    local.isNetworkAccessAllowed = false
    var got = false
    var info: [AnyHashable: Any]?
    PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: local) { img, i in got = img != nil; info = i }
    let inCloud = (info?[PHImageResultIsInCloudKey] as? Bool) ?? false
    let err = (info?[PHImageErrorKey] as? NSError).map { "\($0.domain) \($0.code)" }
    let key = got ? "local" : inCloud ? "icloud only" : "failed: \(err ?? "no error")"
    tally[key, default: 0] += 1
    if !got && inCloud && cloudOnly.count < 5 { cloudOnly.append(asset) }
  }
  var download: [String] = []
  for asset in cloudOnly {
    let net = PHImageRequestOptions()
    net.isSynchronous = true
    net.deliveryMode = .highQualityFormat
    net.isNetworkAccessAllowed = true
    let t = Date()
    var got = false
    var info: [AnyHashable: Any]?
    let scale = min(1, maxSide / Double(max(asset.pixelWidth, asset.pixelHeight)))
    let size = CGSize(width: Double(asset.pixelWidth) * scale, height: Double(asset.pixelHeight) * scale)
    PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: net) { img, i in got = img != nil; info = i }
    let err = (info?[PHImageErrorKey] as? NSError).map { "\($0.domain) \($0.code)" } ?? "none"
    download.append("\(got ? "ok" : "failed") in \(String(format: "%.1f", Date().timeIntervalSince(t))) s, error \(err)")
  }
  emit(["total": assets.count, "tally": tally, "icloud download test": download])

default:
  emit(["error": "unknown command"]); exit(2)
}
