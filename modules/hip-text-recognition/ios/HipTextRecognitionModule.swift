// On-device text recognition, Apple Vision.
//
// Same three settings that made ocr.swift work on a real supplement panel:
//   usesLanguageCorrection = false  — otherwise "Chondroitin" is autocorrected
//   minimumTextHeight lowered       — the default misses 6-point panel type
//   y flipped                       — Vision measures from the bottom-left
//
// Nothing leaves the device. Returns the same shape the app already consumes.

import ExpoModulesCore
import Vision
import CoreGraphics
import ImageIO

public class HipTextRecognitionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HipTextRecognition")

    // Unchanged entry point. Everything that worked before still goes
    // through exactly this path.
    AsyncFunction("recognize") { (uri: String, minimumTextHeight: Double) -> [String: Any] in
      guard let url = Self.resolve(uri) else {
        throw Exception(name: "BadURI", description: "Could not resolve \(uri)")
      }
      guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
            let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw Exception(name: "BadImage", description: "Could not read the image")
      }

      // A photo taken with the phone upright is STORED sideways, with an EXIF
      // tag saying how to rotate it. CGImageSourceCreateImageAtIndex hands back
      // the raw pixels and drops that tag, so Vision would try to read vertical
      // text and find almost nothing. Read the tag and pass it on.
      let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
      let rawOrientation = props?[kCGImagePropertyOrientation] as? UInt32 ?? 1
      let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up

      let req = VNRecognizeTextRequest()
      req.recognitionLevel = .accurate
      req.usesLanguageCorrection = false
      req.recognitionLanguages = ["en-US"]
      req.minimumTextHeight = Float(minimumTextHeight > 0 ? minimumTextHeight : 0.008)

      try VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:]).perform([req])

      var lines: [[String: Any]] = []
      for obs in (req.results ?? []) {
        guard let cand = obs.topCandidates(1).first else { continue }

        var words: [[String: Any]] = []
        for range in Self.wordRanges(cand.string) {
          guard let rect = try? cand.boundingBox(for: range) else { continue }
          words.append([
            "text": String(cand.string[range]),
            "box": Self.flip(rect.boundingBox),
          ])
        }

        lines.append([
          "text": cand.string,
          "confidence": Double(cand.confidence),
          "box": Self.flip(obs.boundingBox),
          "words": words,
        ])
      }

      lines.sort { a, b in
        let ab = a["box"] as? [String: Double] ?? [:]
        let bb = b["box"] as? [String: Double] ?? [:]
        let ay = ab["y"] ?? 0, by = bb["y"] ?? 0
        let tol = max(ab["h"] ?? 0, bb["h"] ?? 0) * 0.5
        return abs(ay - by) > tol ? ay < by : (ab["x"] ?? 0) < (bb["x"] ?? 0)
      }

      return [
        "source": url.lastPathComponent,
        "width": Self.uprightSize(cg, orientation).w,
        "height": Self.uprightSize(cg, orientation).h,
        "orientation": Int(rawOrientation),
        "engine": "apple-vision",
        "lines": lines,
      ]
    }

    // READING THE IMAGE IN TILES.
    //
    // minimumTextHeight is a fraction of the IMAGE, not an absolute size, so
    // 6-point Supplement Facts type on a photograph of a whole carton sits
    // right at the edge of what Vision will look for. Crop that photograph
    // into quarters and the same type is twice as tall relative to its
    // frame, which is the difference between a row being read and being
    // skipped. Nothing else about the recogniser changes.
    //
    // Tiles overlap by a fifth so a line sitting on a seam is whole in at
    // least one of them, and every box is mapped back to full-image
    // coordinates so the result is indistinguishable in shape from an
    // ordinary read.
    //
    // This is slower — rows x cols passes — so it is called only when the
    // plain reads came back thin.
    AsyncFunction("recognizeTiled") {
      (uri: String, minimumTextHeight: Double, rows: Int, cols: Int) -> [String: Any] in
      guard let url = Self.resolve(uri) else {
        throw Exception(name: "BadURI", description: "Could not resolve \(uri)")
      }
      guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
            let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw Exception(name: "BadImage", description: "Could not read the image")
      }
      let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
      let rawOrientation = props?[kCGImagePropertyOrientation] as? UInt32 ?? 1
      let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up

      let nR = max(1, min(4, rows))
      let nC = max(1, min(4, cols))
      let size = Self.uprightSize(cg, orientation)
      let W = Double(size.w)
      let H = Double(size.h)
      let overlap = 0.2

      var all: [[String: Any]] = []
      for r in 0..<nR {
        for c in 0..<nC {
          // Tile bounds in the UPRIGHT frame, as fractions.
          let x0 = max(0.0, (Double(c) / Double(nC)) - overlap / Double(nC))
          let x1 = min(1.0, (Double(c + 1) / Double(nC)) + overlap / Double(nC))
          let y0 = max(0.0, (Double(r) / Double(nR)) - overlap / Double(nR))
          let y1 = min(1.0, (Double(r + 1) / Double(nR)) + overlap / Double(nR))

          let rect = CGRect(x: x0 * W, y: y0 * H, width: (x1 - x0) * W, height: (y1 - y0) * H)
          guard let upright = Self.upright(cg, orientation),
                let tile = upright.cropping(to: rect) else { continue }

          let req = VNRecognizeTextRequest()
          req.recognitionLevel = .accurate
          req.usesLanguageCorrection = false
          req.recognitionLanguages = ["en-US"]
          req.minimumTextHeight = Float(minimumTextHeight > 0 ? minimumTextHeight : 0.008)
          // The tile is already upright, so no orientation is applied again.
          guard (try? VNImageRequestHandler(cgImage: tile, options: [:]).perform([req])) != nil
          else { continue }

          for obs in (req.results ?? []) {
            guard let cand = obs.topCandidates(1).first else { continue }
            var words: [[String: Any]] = []
            for range in Self.wordRanges(cand.string) {
              guard let wr = try? cand.boundingBox(for: range) else { continue }
              words.append([
                "text": String(cand.string[range]),
                "box": Self.place(Self.flip(wr.boundingBox), x0, y0, x1 - x0, y1 - y0),
              ])
            }
            all.append([
              "text": cand.string,
              "confidence": Double(cand.confidence),
              "box": Self.place(Self.flip(obs.boundingBox), x0, y0, x1 - x0, y1 - y0),
              "words": words,
            ])
          }
        }
      }

      // Overlapping tiles see the same line twice. Keep the first of any
      // pair with the same text at nearly the same place.
      var kept: [[String: Any]] = []
      for line in all {
        let t = line["text"] as? String ?? ""
        let b = line["box"] as? [String: Double] ?? [:]
        let dup = kept.contains { other in
          guard (other["text"] as? String) == t else { return false }
          let ob = other["box"] as? [String: Double] ?? [:]
          return abs((ob["x"] ?? 0) - (b["x"] ?? 0)) < 0.02
              && abs((ob["y"] ?? 0) - (b["y"] ?? 0)) < 0.02
        }
        if !dup { kept.append(line) }
      }

      kept.sort { a, b in
        let ab = a["box"] as? [String: Double] ?? [:]
        let bb = b["box"] as? [String: Double] ?? [:]
        let ay = ab["y"] ?? 0, by = bb["y"] ?? 0
        let tol = max(ab["h"] ?? 0, bb["h"] ?? 0) * 0.5
        return abs(ay - by) > tol ? ay < by : (ab["x"] ?? 0) < (bb["x"] ?? 0)
      }

      return [
        "source": url.lastPathComponent,
        "width": size.w,
        "height": size.h,
        "orientation": Int(rawOrientation),
        "engine": "apple-vision-tiled",
        "lines": kept,
      ]
    }

    // FINDING THE PRINTED RULES.
    //
    // 21 CFR 101.36 requires a Supplement Facts panel to be ruled: a hairline
    // between nutrients, heavier bars between sections. Those rules are the
    // label telling you, in ink, exactly where one row ends and the next
    // begins — and on a curved bottle the rule bends with the surface
    // exactly as the text does, so a bent rule is a BETTER row boundary than
    // any straight line fitted through the text could be.
    //
    // Found by projection profile, not edge detection: in a narrow vertical
    // strip, a printed rule is a pixel row that is much darker than the rows
    // immediately above and below it, and only a pixel or two thick. Text is
    // darker too, but across many more rows. Doing it per strip and linking
    // the results is what lets a rule be followed as it curves.
    AsyncFunction("detectSeparators") { (uri: String) -> [String: Any] in
      guard let url = Self.resolve(uri) else {
        throw Exception(name: "BadURI", description: "Could not resolve \(uri)")
      }
      guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
            let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw Exception(name: "BadImage", description: "Could not read the image")
      }
      let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
      let rawOrientation = props?[kCGImagePropertyOrientation] as? UInt32 ?? 1
      let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
      guard let upright = Self.upright(cg, orientation) else {
        return ["separators": [], "engine": "rules-none"]
      }

      // Downsample hard. A hairline survives at this width and the whole
      // pass costs a few milliseconds instead of a second.
      let W = 1000
      let H = max(1, Int((Double(upright.height) / Double(upright.width)) * Double(W)))
      guard let gray = CGContext(
        data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W,
        space: CGColorSpaceCreateDeviceGray(),
        bitmapInfo: CGImageAlphaInfo.none.rawValue),
        let buf = gray.data else {
        return ["separators": [], "engine": "rules-none"]
      }
      gray.draw(upright, in: CGRect(x: 0, y: 0, width: W, height: H))
      let px = buf.bindMemory(to: UInt8.self, capacity: W * H)

      let strips = 24
      let stripW = W / strips
      // One candidate list per strip: the y rows that look like a rule.
      var perStrip: [[(y: Int, strength: Double)]] = []

      for sIdx in 0..<strips {
        let x0 = sIdx * stripW
        let x1 = min(W, x0 + stripW)
        // Mean darkness of every pixel row within this strip. The bitmap is
        // drawn bottom-up by CGContext, so row 0 here is the BOTTOM of the
        // image; the flip happens when the result is normalised below.
        var profile = [Double](repeating: 0, count: H)
        for y in 0..<H {
          var sum = 0
          for x in x0..<x1 { sum += Int(px[y * W + x]) }
          profile[y] = 255.0 - (Double(sum) / Double(max(1, x1 - x0)))
        }

        var hits: [(y: Int, strength: Double)] = []
        // A rule is dark relative to its IMMEDIATE neighbourhood, not to the
        // page: a dense block of text raises the local average, and a rule
        // inside a table still stands out against the gaps around it.
        let near = 6
        for y in near..<(H - near) {
          let here = profile[y]
          if here < 40 { continue }   // nothing like ink
          var around = 0.0
          var n = 0
          for d in 2...near {
            around += profile[y - d] + profile[y + d]
            n += 2
          }
          let local = around / Double(n)
          if here < local * 1.8 { continue }        // not dark enough to stand out
          // Thin: the run of dark rows containing y must be short. Text gives
          // a thick run, a hairline gives one or two.
          var up = y, down = y
          while up > 0 && profile[up - 1] > local * 1.4 { up -= 1 }
          while down < H - 1 && profile[down + 1] > local * 1.4 { down += 1 }
          if down - up > 4 { continue }
          hits.append((y: (up + down) / 2, strength: here - local))
        }

        // Keep the strongest in any tight cluster, so one rule yields one hit.
        hits.sort { $0.strength > $1.strength }
        var kept: [(y: Int, strength: Double)] = []
        for h in hits {
          if kept.contains(where: { abs($0.y - h.y) < 4 }) { continue }
          kept.append(h)
        }
        perStrip.append(kept)
      }

      // Link hits across adjacent strips into polylines. A rule that bends
      // moves a little from strip to strip; anything that jumps is not the
      // same rule.
      var used = Set<String>()
      var lines: [[String: Any]] = []
      for sIdx in 0..<strips {
        for h in perStrip[sIdx] {
          let key = "\(sIdx):\(h.y)"
          if used.contains(key) { continue }
          used.insert(key)

          var pts: [(x: Double, y: Double)] = [
            (x: (Double(sIdx) + 0.5) * Double(stripW) / Double(W), y: Double(h.y)),
          ]
          var strengthSum = h.strength
          var lastY = h.y
          var next = sIdx + 1
          while next < strips {
            // The nearest unused hit in the next strip, if it is close enough
            // to be the same rule continuing.
            var best: (y: Int, strength: Double)? = nil
            for c in perStrip[next] where !used.contains("\(next):\(c.y)") {
              if abs(c.y - lastY) > 8 { continue }
              if best == nil || abs(c.y - lastY) < abs(best!.y - lastY) { best = c }
            }
            guard let b = best else { break }
            used.insert("\(next):\(b.y)")
            pts.append((x: (Double(next) + 0.5) * Double(stripW) / Double(W), y: Double(b.y)))
            strengthSum += b.strength
            lastY = b.y
            next += 1
          }

          let span = Double(pts.count) / Double(strips)
          // A rule runs across the table. A short dark run is a letter.
          if span < 0.6 { continue }
          lines.append([
            "points": pts.map { [
              "x": $0.x,
              // CGContext draws bottom-up; everything downstream is top-down.
              "y": 1.0 - ($0.y / Double(H)),
            ] },
            "strength": strengthSum / Double(pts.count),
            "span": span,
          ])
        }
      }

      return [
        "separators": lines,
        "width": W,
        "height": H,
        "engine": "rules-projection",
      ]
    }

  }
  /// A tile's box, in fractions of the tile, moved into the full image.
  private static func place(
    _ b: [String: Double], _ x0: Double, _ y0: Double, _ w: Double, _ h: Double
  ) -> [String: Double] {
    [
      "x": x0 + (b["x"] ?? 0) * w,
      "y": y0 + (b["y"] ?? 0) * h,
      "w": (b["w"] ?? 0) * w,
      "h": (b["h"] ?? 0) * h,
    ]
  }

  /// Bake the EXIF rotation into the pixels, so tiles can be cropped in the
  /// same coordinate system everything downstream reasons about.
  private static func upright(_ cg: CGImage, _ o: CGImagePropertyOrientation) -> CGImage? {
    if o == .up { return cg }
    let size = uprightSize(cg, o)
    guard let ctx = CGContext(
      data: nil, width: size.w, height: size.h, bitsPerComponent: 8, bytesPerRow: 0,
      space: cg.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }

    let w = CGFloat(cg.width)
    let h = CGFloat(cg.height)
    switch o {
    case .right, .rightMirrored:
      ctx.translateBy(x: CGFloat(size.w), y: 0); ctx.rotate(by: .pi / 2)
    case .left, .leftMirrored:
      ctx.translateBy(x: 0, y: CGFloat(size.h)); ctx.rotate(by: -.pi / 2)
    case .down, .downMirrored:
      ctx.translateBy(x: CGFloat(size.w), y: CGFloat(size.h)); ctx.rotate(by: .pi)
    default: break
    }
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
  }


  /// Vision works on the UPRIGHT image, so a 90-degree tag swaps width and height.
  /// Everything downstream reasons about the upright frame, so report that.
  private static func uprightSize(
    _ cg: CGImage, _ o: CGImagePropertyOrientation
  ) -> (w: Int, h: Int) {
    switch o {
    case .left, .leftMirrored, .right, .rightMirrored:
      return (cg.height, cg.width)
    default:
      return (cg.width, cg.height)
    }
  }

  /// Vision measures from the bottom-left; everything downstream assumes top-left.
  private static func flip(_ r: CGRect) -> [String: Double] {
    [
      "x": Double(r.origin.x),
      "y": Double(1 - r.origin.y - r.size.height),
      "w": Double(r.size.width),
      "h": Double(r.size.height),
    ]
  }

  private static func resolve(_ uri: String) -> URL? {
    if uri.hasPrefix("file://") { return URL(string: uri) }
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    return URL(string: uri)
  }

  private static func wordRanges(_ s: String) -> [Range<String.Index>] {
    var out: [Range<String.Index>] = []
    var i = s.startIndex
    while i < s.endIndex {
      while i < s.endIndex, s[i].isWhitespace { i = s.index(after: i) }
      guard i < s.endIndex else { break }
      let start = i
      while i < s.endIndex, !s[i].isWhitespace { i = s.index(after: i) }
      out.append(start..<i)
    }
    return out
  }
}
