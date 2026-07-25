#!/usr/bin/env swift
//
// Apple Vision OCR helper for the headless PDF reconstruction CLI.
//
// Usage: swift apple-vision-recognize.swift <page.png> [--languages en-US,...]
//
// Reads one already-rasterized page image from the local filesystem and writes a
// single JSON object to stdout in the shared recognition contract: line and word
// boxes in raster pixels with a top-left origin, per-token confidence, and the
// engine and model versions. Nothing is written to disk and nothing leaves this
// host. Errors are reported on stderr with a non-zero exit status; no local path
// is echoed back.

import CoreGraphics
import Foundation
import ImageIO
import Vision

let responseSchemaVersion = "1.0.0"
let engineIdentifier = "apple-vision"
let modelIdentifier = "vn-recognize-text"

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

var imagePath: String?
var requestedLanguages = ["en-US"]

var arguments = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < arguments.count {
  let argument = arguments[index]
  if argument == "--languages" {
    guard index + 1 < arguments.count else { fail("MISSING_LANGUAGES") }
    requestedLanguages = arguments[index + 1]
      .split(separator: ",")
      .map { String($0) }
      .filter { !$0.isEmpty }
    index += 2
    continue
  }
  if argument.hasPrefix("--languages=") {
    requestedLanguages = String(argument.dropFirst("--languages=".count))
      .split(separator: ",")
      .map { String($0) }
      .filter { !$0.isEmpty }
    index += 1
    continue
  }
  if argument.hasPrefix("--") { fail("UNKNOWN_OPTION") }
  guard imagePath == nil else { fail("DUPLICATE_IMAGE_ARGUMENT") }
  imagePath = argument
  index += 1
}

guard let imagePath, !requestedLanguages.isEmpty else { fail("INVALID_USAGE") }

guard
  let source = CGImageSourceCreateWithURL(
    URL(fileURLWithPath: imagePath) as CFURL, nil),
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  fail("UNREADABLE_PAGE_RASTER")
}

let width = Double(image.width)
let height = Double(image.height)
guard width > 0, height > 0 else { fail("EMPTY_PAGE_RASTER") }

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = requestedLanguages
if #available(macOS 13.0, *) {
  request.revision = VNRecognizeTextRequestRevision3
}

do {
  try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
  fail("RECOGNITION_FAILED")
}

// Vision reports normalized rectangles with a bottom-left origin; the shared
// contract uses raster pixels with a top-left origin.
func pixelBox(_ rect: CGRect) -> [String: Double] {
  [
    "x0": Double(rect.minX) * width,
    "y0": (1 - Double(rect.maxY)) * height,
    "x1": Double(rect.maxX) * width,
    "y1": (1 - Double(rect.minY)) * height,
  ]
}

var lines: [[String: Any]] = []
for observation in request.results ?? [] {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let text = candidate.string
  if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }

  var words: [[String: Any]] = []
  var cursor = text.startIndex
  while cursor < text.endIndex {
    guard
      let start = text[cursor...].firstIndex(where: {
        !$0.isWhitespace
      })
    else { break }
    let end =
      text[start...].firstIndex(where: { $0.isWhitespace }) ?? text.endIndex
    let range = start..<end
    // A token whose box Vision cannot express falls back to the line box so the
    // contract always carries a word box for recognized text.
    let tokenObservation = (try? candidate.boundingBox(for: range)) ?? nil
    let box = tokenObservation?.boundingBox
    words.append([
      "text": String(text[range]),
      "confidence": Double(candidate.confidence),
      "bbox": pixelBox(box ?? observation.boundingBox),
    ])
    cursor = end
  }

  lines.append([
    "text": text,
    "confidence": Double(candidate.confidence),
    "bbox": pixelBox(observation.boundingBox),
    "words": words,
  ])
}

let version = ProcessInfo.processInfo.operatingSystemVersion
let response: [String: Any] = [
  "schemaVersion": responseSchemaVersion,
  "engine": engineIdentifier,
  "engineVersion":
    "macos-\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
  "model": modelIdentifier,
  "modelVersion": "3",
  "raster": ["width": image.width, "height": image.height],
  "lines": lines,
]

guard
  let encoded = try? JSONSerialization.data(
    withJSONObject: response, options: [.sortedKeys])
else {
  fail("UNSERIALIZABLE_RESPONSE")
}
FileHandle.standardOutput.write(encoded)
