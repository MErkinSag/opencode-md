import { test } from "node:test"
import assert from "node:assert/strict"
import { createRaster } from "../raster.mjs"
import { terminalFont } from "../font.mjs"

const input = { text: "Elegant OpenCode", level: 1, columns: 80, cellWidth: 16, cellHeight: 32, color: "#223344",
  fontFamilies: await terminalFont() ?? [] }
test("headings have real PNG dimensions, wrap, and cache without another raster", () => {
  const cache = createRaster()
  const first = cache.render(input)
  assert.equal(first.png.subarray(1, 4).toString(), "PNG")
  assert.equal(first.png.readUInt32BE(16), first.width)
  assert.equal(first.png.readUInt32BE(20), first.height)
  assert.equal(cache.render(input), first)
  assert.equal(cache.stats.renders, 1)
  const narrow = cache.render({ ...input, columns: 12, text: "A long heading with 中文 and 👨‍👩‍👧‍👦 family" })
  assert.ok(narrow.lines.length > 1)
  assert.equal(narrow.lines.filter(line => line.includes("👨‍👩‍👧‍👦")).length, 1)
  assert.ok(narrow.height > first.height)
  assert.notEqual(cache.render({ ...input, color: "#eeeeee" }), first)
  assert.notEqual(cache.render({ ...input, cellWidth: 8, cellHeight: 16 }), first)
  const otherFont = cache.render({ ...input, fontFamilies: ["Helvetica Neue", "Arial"] })
  assert.notEqual(otherFont, first)
  assert.notDeepEqual(otherFont.png, first.png)
  assert.notDeepEqual(otherFont.boxes, first.boxes)
  assert.equal(cache.render(input), first)
})

test("decoded and compressed cache memory is bounded", () => {
  const cache = createRaster(1_000_000)
  for (let i = 0; i < 50; i++) cache.render({ ...input, text: `Heading ${i}` })
  assert.ok(cache.stats.bytes <= 1_000_000)
  const count = cache.stats.renders
  cache.render({ ...input, text: "Heading 0" })
  assert.equal(cache.stats.renders, count + 1)
  cache.clear()
  assert.equal(cache.stats.bytes, 0)
})

test("all heading sizes keep more space above and never give smaller fonts larger gaps", () => {
  const cache = createRaster()
  for (const cellHeight of [16, 32, 37.5, 47]) {
    for (const columns of [18, 80]) {
      for (const text of ["Overview", "Heading with descenders", "A longer heading with 中文 and 👨‍👩‍👧‍👦"]) {
        const layouts = Array.from({ length: 6 }, (_, i) => cache.render({
          ...input, text, level: i + 1, cellHeight, columns,
        }))
        const gaps = layouts.map(layout => ({
          above: layout.paddingTop * cellHeight + layout.boxes[0].top,
          below: layout.height - layout.boxes.at(-1).bottom,
        }))
        for (let i = 1; i < gaps.length; i++) {
          if (i <= 3) {
            assert.ok(gaps[i].below < gaps[i - 1].below, `H${i + 1} bottom gap must shrink`)
            assert.ok(gaps[i].above < gaps[i - 1].above, `H${i + 1} top gap must shrink`)
          } else {
            assert.deepEqual(gaps[i], gaps[i - 1], "H4–H6 must share the same compact spacing")
          }
        }
        for (const gap of gaps) assert.ok(gap.above > gap.below, `${text}: top gap must be larger`)
        for (const layout of layouts) {
          assert.ok(layout.boxes[0].top >= 0)
          assert.ok(layout.boxes.at(-1).bottom < layout.height)
        }
      }
    }
  }
})
