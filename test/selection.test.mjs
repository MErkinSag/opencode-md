import { test } from "node:test"
import assert from "node:assert/strict"
import { createRaster } from "../raster.mjs"
import { select, highlight } from "../selection.mjs"
import { terminalFont } from "../font.mjs"

const raster = createRaster()
const options = { text: "Elegant OpenCode", level: 1, columns: 80, cellWidth: 16, cellHeight: 32, color: "#223344",
  fontFamilies: await terminalFont() ?? [] }
// Pixel-resolution bounds let us check exact glyph mappings independently of
// terminal-cell quantization, which the actual PTY integration test exercises.
const bounds = layout => ({ x: 10, y: 20, width: layout.width, height: layout.height })
const range = (anchor, focus, behavior = "cell") => ({ anchor, focus, behavior, isActive: true })

test("full, reverse, partial and cross-block selection return text", () => {
  const layout = raster.render(options)
  const box = bounds(layout)
  const start = { x: box.x, y: box.y }
  const end = { x: box.x + box.width, y: box.y + box.height - 1 }
  assert.deepEqual(select(layout, range(start, end), box), { start: 0, end: layout.text.length })
  assert.deepEqual(select(layout, range(end, start), box), { start: 0, end: layout.text.length })
  const glyphs = layout.boxes[0].glyphs
  const partial = select(layout, range(
    { x: box.x + glyphs[0].left, y: box.y + layout.boxes[0].top },
    { x: box.x + glyphs[6].right - 1, y: box.y + layout.boxes[0].top },
  ), box)
  assert.equal(layout.text.slice(partial.start, partial.end), "Elegant")
  assert.deepEqual(select(layout, range({ x: 0, y: 0 }, { x: 0, y: box.y + box.height + 50 }), box),
    { start: 0, end: layout.text.length })
  assert.equal(select(layout, range({ x: 0, y: 0 }, { x: 0, y: 1 }), box), null)
  assert.equal(select(layout, range({ x: 0, y: 9999 }, { x: 0, y: 10000 }), box), null)
  assert.equal(select(layout, null, box), null)
})

test("wrapped Unicode selection preserves whole graphemes and logical text", () => {
  const layout = raster.render({ ...options, text: "A heading with 中文 and 👨‍👩‍👧‍👦 family e\u0301", columns: 12 })
  assert.ok(layout.lines.length > 1)
  const box = bounds(layout)
  const whole = select(layout, range({ x: 0, y: 0 }, { x: 9999, y: 9999 }), box)
  assert.equal(layout.text.slice(whole.start, whole.end), "A heading with 中文 and 👨‍👩‍👧‍👦 family e\u0301")
  const line = layout.boxes.find(line => line.glyphs.some(glyph => layout.text.slice(glyph.start, glyph.end) === "👨‍👩‍👧‍👦"))
  const glyph = line.glyphs.find(glyph => layout.text.slice(glyph.start, glyph.end) === "👨‍👩‍👧‍👦")
  const emoji = select(layout, range(
    { x: box.x + glyph.left + 1, y: box.y + (line.top + line.bottom) / 2 },
    { x: box.x + glyph.right - 2, y: box.y + (line.top + line.bottom) / 2 },
  ), box)
  assert.equal(layout.text.slice(emoji.start, emoji.end), "👨‍👩‍👧‍👦")
})

test("word expansion and highlight use existing raster without mutating it", () => {
  const layout = raster.render(options)
  const box = bounds(layout)
  const point = { x: box.x + layout.boxes[0].glyphs[2].left, y: box.y + layout.boxes[0].top }
  const word = select(layout, range(point, point, "word"), box)
  assert.equal(layout.text.slice(word.start, word.end), "Elegant")
  const before = Buffer.from(layout.png)
  const count = raster.stats.renders
  assert.notDeepEqual(highlight(layout, word), before)
  assert.deepEqual(layout.png, before)
  assert.equal(highlight(layout, null), layout.png)
  assert.equal(raster.stats.renders, count)
})
