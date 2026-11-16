import { createCanvas, GlobalFonts } from "@napi-rs/canvas"

// Only headings pass through this rasterizer. No browser, document layout, or
// subprocess is involved. Bounded LRU keys include font, width, density and color.
export function createRaster(limit = 8 * 1024 * 1024) {
  const cache = new Map()
  const faces = new Map(GlobalFonts.families.map(font => [font.family.toLowerCase(), font.styles]))
  const stats = { renders: 0, hits: 0, bytes: 0, milliseconds: 0 }
  function render({ text, level, columns, cellWidth, cellHeight, color, background = "#ffffff", fontFamilies = [] }) {
    const key = JSON.stringify([text, level, columns, cellWidth, cellHeight, color, background, fontFamilies])
    if (cache.has(key)) {
      const value = cache.get(key)
      cache.delete(key)
      cache.set(key, value)
      stats.hits++
      return value
    }
    const start = performance.now()
    const available = Math.max(1, Math.min(4096, Math.floor(columns * cellWidth)))
    const measure = createCanvas(1, 1).getContext("2d")
    const family = [...fontFamilies.map(name => JSON.stringify(name)), "monospace"].join(", ")
    const face = fontFamilies.map(name => faces.get(name.toLowerCase())).find(Boolean)
    // Operator Mono Lig may only have a Book face installed. In that case
    // Canvas's 600/700 weights look identical: add a small em-scaled outline.
    const embolden = face && !face.some(style => style.style === "normal" && style.weight >= 600)
    const normalized = text.replace(/\s+/g, " ").trim()
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    // Four visual sizes. H4–H6 share one compact body-sized heading style:
    // shrinking a glyph inside the same terminal row would ADD whitespace.
    const styles = [
      { scale: .85, before: .08, after: .45 },
      { scale: 1, before: .35, after: .9 },
      { scale: 1.2, before: .65, after: 1.125 },
      { scale: 1.45, before: 1, after: 1.29375 },
    ]
    let plan
    for (const style of styles.slice(0, Math.max(1, Math.min(4, 5 - level)))) {
      const size = cellHeight * style.scale
      const font = `700 ${size}px ${family}`
      const spread = embolden ? size * .015 : 0
      const inset = 2 + spread
      measure.font = font
      const lines = [""]
      // Wrap at word boundaries, splitting long words only at graphemes.
      for (const word of normalized.split(/(?<=\s)/u)) {
        const index = lines.length - 1
        if (measure.measureText(lines[index] + word).width <= available - inset * 2) {
          lines[index] += word
          continue
        }
        if (lines[index]) lines.push("")
        for (const { segment } of segmenter.segment(word.trimStart())) {
          if (lines.at(-1) && measure.measureText(lines.at(-1) + segment).width > available - inset * 2) lines.push("")
          lines[lines.length - 1] += segment
        }
      }
      const metrics = lines.map(line => measure.measureText(line.trimEnd()))
      const top = Math.min(...metrics.map((metric, i) => i * size * 1.2 - metric.actualBoundingBoxAscent)) - spread
      const bottom = Math.max(...metrics.map((metric, i) => i * size * 1.2 + metric.actualBoundingBoxDescent)) + spread
      const after = size * style.after
      // Account for the ACTUAL rounded gap of the smaller size, including
      // wrapped headings. Requested em values alone cannot ensure this.
      const before = Math.max(size * style.before, after * 1.5,
        plan ? plan.leading + Math.max(2, cellHeight * .08) : 0)
      const ink = Math.max(bottom - top, (lines.length - 1) * size * 1.2 + size * .85)
      const reserved = Math.max(1, Math.ceil((ink + before + after) / cellHeight))
      plan = { size, font, spread, inset, lines, metrics, top, bottom, after, reserved,
        leading: reserved * cellHeight - after - (bottom - top) }
    }
    const { size, font, spread, inset, lines, metrics, top, bottom, after, reserved, leading } = plan
    // Keep whole blank rows outside the selectable image, so a drag into the
    // heading doesn't accidentally reach text in the preceding paragraph.
    const paddingTop = Math.max(0, Math.floor(leading / cellHeight))
    const rows = reserved - paddingTop
    const height = Math.ceil(rows * cellHeight)
    const occupied = Math.max(1, Math.min(columns, Math.ceil((Math.max(...lines.map(line => measure.measureText(line.trimEnd()).width)) + inset * 2) / cellWidth)))
    const width = Math.min(available, Math.ceil(occupied * cellWidth))
    // Extremely large headings fall back to native text in the adapter.
    if (width * height > 2_000_000) throw new Error("Heading exceeds image budget")
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext("2d")
    // Opaque background avoids Ghostty compositing transparent pixels against
    // the terminal's default background rather than the TUI's cell background.
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, height)
    ctx.font = font
    ctx.fillStyle = color
    ctx.strokeStyle = color
    ctx.lineWidth = spread * 2
    ctx.lineJoin = "round"
    // Keep the font-scaled bottom gap exact. Put cell-rounding slack above,
    // so small headings cannot acquire an oversized gap to the paragraph.
    const baseline = height - after - bottom
    ctx.textBaseline = "alphabetic"
    lines.forEach((line, i) => {
      const y = baseline + i * size * 1.2
      if (spread) ctx.strokeText(line.trimEnd(), inset, y)
      ctx.fillText(line.trimEnd(), inset, y)
    })
    let offset = 0
    const boxes = lines.map((line, row) => {
      const value = line.trimEnd()
      const start = normalized.indexOf(value, offset)
      offset = start + value.length
      const glyphs = [...segmenter.segment(value)].map(({ segment, index }) => ({
        start: start + index, end: start + index + segment.length,
        left: inset + measure.measureText(value.slice(0, index)).width,
        right: inset + measure.measureText(value.slice(0, index + segment.length)).width,
      }))
      return {
        start, end: offset, glyphs,
        top: baseline + row * size * 1.2 - metrics[row].actualBoundingBoxAscent - spread,
        bottom: baseline + row * size * 1.2 + metrics[row].actualBoundingBoxDescent + spread,
      }
    })
    const result = { png: canvas.toBuffer("image/png"), canvas, font, text: normalized, boxes, rows, paddingTop, columns: occupied, width, height, lines }
    stats.renders++
    stats.milliseconds += performance.now() - start
    // Account for decoded pixels too, not just compressed PNG bytes.
    result.bytes = width * height * 4 + result.png.byteLength
    if (result.bytes <= limit) {
      while (stats.bytes + result.bytes > limit && cache.size) {
        const oldest = cache.keys().next().value
        stats.bytes -= cache.get(oldest).bytes
        cache.delete(oldest)
      }
      cache.set(key, result)
      stats.bytes += result.bytes
    }
    return result
  }
  return { render, stats, clear() { cache.clear(); stats.bytes = 0 } }
}
