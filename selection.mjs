import { createCanvas } from "@napi-rs/canvas"

// Map terminal-cell mouse coordinates onto the proportional glyph geometry.
// Offsets are UTF-16 boundaries supplied by Intl.Segmenter, so selections never
// split a surrogate pair, combining sequence, or joined emoji.
export function select(layout, selection, bounds) {
  if (!selection?.isActive || !layout.boxes.length) return null
  const points = [selection.anchor, selection.focus].sort((a, b) => a.y - b.y || a.x - b.x)
  const point = (position, end) => {
    const y = (position.y - bounds.y + .5) * layout.height / bounds.height
    if (y < 0) return { index: 0, line: 0 }
    if (y >= layout.height) return { index: layout.text.length, line: layout.boxes.length - 1 }
    const row = layout.boxes.findIndex((line, i) => i === layout.boxes.length - 1 || y < (line.bottom + layout.boxes[i + 1].top) / 2)
    const line = layout.boxes[row]
    const x = (position.x - bounds.x + (end ? 1 : 0)) * layout.width / bounds.width
    const glyph = line.glyphs.find(glyph => end ? glyph.left >= x : glyph.right > x)
    return { index: glyph?.start ?? line.end, line: row }
  }
  const from = point(points[0], false)
  const to = point(points[1], true)
  let start = from.index
  let end = to.index
  if (selection.behavior === "line") {
    start = layout.boxes[from.line].start
    end = layout.boxes[to.line].end
  }
  if (selection.behavior === "word") {
    const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(layout.text)]
    start = words.find(word => word.index <= start && word.index + word.segment.length > start)?.index ?? start
    const word = words.find(word => word.index < end && word.index + word.segment.length >= end)
    end = word ? word.index + word.segment.length : end
  }
  return end > start ? { start, end } : null
}

export function highlight(layout, range) {
  if (!range) return layout.png
  const canvas = createCanvas(layout.width, layout.height)
  const ctx = canvas.getContext("2d")
  ctx.drawImage(layout.canvas, 0, 0)
  ctx.fillStyle = "rgba(65, 135, 245, 0.32)"
  for (const line of layout.boxes) {
    const glyphs = line.glyphs.filter(glyph => glyph.end > range.start && glyph.start < range.end)
    if (!glyphs.length) continue
    ctx.fillRect(glyphs[0].left, Math.max(0, line.top - 2),
      glyphs.at(-1).right - glyphs[0].left, line.bottom - line.top + 4)
  }
  return canvas.toBuffer("image/png")
}
