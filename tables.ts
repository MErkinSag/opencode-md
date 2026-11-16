import { TextTableRenderable, type MarkdownRenderable, type OptimizedBuffer, type TextBufferView } from "@opentui/core"
import type { Appearance } from "./appearance"

type Content = TextTableRenderable["content"]
type Cell = NonNullable<Content[number][number]>
type State = { source: Content; cells: WeakMap<Cell, Map<number, Cell>>; update: () => void; restore: () => void }
type Layout = { rowOffsets: number[]; rowHeights: number[]; columnOffsets: number[]; columnWidths: number[] }
type NativeCell = { textBufferView: TextBufferView }

// OpenTUI only exposes uniform padding. Give the header three columns on each
// side and one row above/below, while body cells keep two columns on each side.
// Selection uses that same text geometry; hit testing still sees the full cell.
function padHeader(table: TextTableRenderable, range: boolean) {
  const keys = ["computeColumnWidths", "computeRowHeights", "applyLayoutToViews", "applySelectionToCells",
    "getFullCellSelectionCoords", "getCellAtLocalPosition", "findRowForLocalY"]
  const undo: (() => void)[] = []
  const cache = new WeakMap<Layout, Layout>()
  let grid: Layout | undefined
  let offsetSelection = false
  const cells = () => Reflect.get(table, "_cells") as NativeCell[][]

  function withFields<T>(fields: Record<string, unknown>, run: () => T): T {
    const previous = Object.keys(fields).map(key => [key, Reflect.get(table, key)] as const)
    for (const [key, value] of Object.entries(fields)) Reflect.set(table, key, value)
    try { return run() }
    finally { for (const [key, value] of previous) Reflect.set(table, key, value) }
  }

  function withHeader<T>(run: () => T) {
    return withFields({ _rowCount: Math.min(1, cells().length),
      _cellPaddingX: table.cellPaddingX + 1, _cellPaddingY: 1 }, run)
  }

  function localSelection<T>(run: () => T): T {
    const previous = offsetSelection
    offsetSelection = false
    try { return run() }
    finally { offsetSelection = previous }
  }

  function selectHeader<T>(run: () => T): T {
    const restore: (() => void)[] = []
    const previous = offsetSelection
    try {
      // Native selection still owns column locking, direction, and copy text.
      // Translate only screen-derived header coordinates into its inset view.
      for (const cell of cells()[0] ?? []) {
        for (const key of ["setLocalSelection", "updateLocalSelection"] as const) {
          const view = cell.textBufferView
          const original = view[key]
          const own = Object.getOwnPropertyDescriptor(view, key)
          view[key] = (ax, ay, fx, fy, ...colors) =>
            original.call(view, ax - Number(offsetSelection), ay, fx - Number(offsetSelection), fy, ...colors)
          restore.push(() => {
            if (own) Object.defineProperty(view, key, own)
            else Reflect.deleteProperty(view, key)
          })
        }
      }
      offsetSelection = true
      return withText(run)
    } finally {
      offsetSelection = previous
      restore.forEach(undo => undo())
    }
  }

  function textLayout(layout: Layout) {
    if (!layout.rowHeights.length) return layout
    let result = cache.get(layout)
    if (!result) {
      result = { ...layout, rowOffsets: [...layout.rowOffsets], rowHeights: [...layout.rowHeights] }
      result.rowOffsets[0]++
      result.rowHeights[0] -= 2
      cache.set(layout, result)
    }
    return result
  }

  function withLayout<T>(layout: Layout, run: () => T) {
    const previous = Reflect.get(table, "_layout")
    Reflect.set(table, "_layout", layout)
    try { return run() }
    finally { Reflect.set(table, "_layout", previous) }
  }

  function withText<T>(run: () => T): T {
    const previous = grid
    grid ??= Reflect.get(table, "_layout") as Layout
    try { return withLayout(textLayout(grid), run) }
    finally { grid = previous }
  }

  // Leave an unfamiliar runtime's native geometry intact.
  if (!keys.every(key => typeof Reflect.get(table, key) === "function"))
    return { draw: (run: (a: number, b: number) => unknown, a: number, b: number) => run(a, b), restore() {} }

  for (const key of [...keys, "movedAnchor", "pressOffset"]) {
    const original = Reflect.get(table, key)
    if (typeof original !== "function") continue
    const own = Object.getOwnPropertyDescriptor(table, key)
    const wrapper = (...args: unknown[]) => {
      const run = () => Reflect.apply(original, table, args)
      if (key === "computeColumnWidths") {
        // Reserve enough width for the larger inset, including narrow columns.
        return withFields({ _cellPaddingX: table.cellPaddingX + 1 }, run)
      }
      if (key === "computeRowHeights") {
        const heights = run() as number[]
        if (heights.length) heights[0] = (withHeader(run) as number[])[0]
        return heights
      }
      if (key === "applyLayoutToViews") {
        run()
        return withHeader(run)
      }
      if (key === "applySelectionToCells") return selectHeader(run)
      if (key === "getFullCellSelectionCoords") {
        if (args[0] !== 0) return run()
        const coords = withFields({ _cellPaddingX: table.cellPaddingX + 1 }, run)
        // Full-cell coordinates are already local; cancel the translation.
        return offsetSelection ? { ...coords, anchorX: coords.anchorX + 1, focusX: coords.focusX + 1 } : coords
      }
      // Newer OpenTUI probes local view coordinates to retain a dragged anchor
      // across reflow. These probes must not be translated as screen positions.
      if (key === "pressOffset") return localSelection(run)
      if (key === "movedAnchor") return localSelection(() => {
        if (Reflect.get(table, "_pressedCell")?.rowIdx === 0)
          return withFields({ _cellPaddingX: table.cellPaddingX + 1 }, run)
        return run()
      })
      return grid ? withLayout(grid, run) : run()
    }
    Reflect.set(table, key, wrapper)
    undo.push(() => {
      if (Reflect.get(table, key) !== wrapper) return
      if (own) Object.defineProperty(table, key, own)
      else Reflect.deleteProperty(table, key)
    })
  }
  return {
    draw(run: (a: number, b: number) => unknown, a: number, b: number) {
      if (range) {
        if (a === 0 && b >= 0) withHeader(() => run(0, 0))
        if (b >= Math.max(1, a)) return run(Math.max(1, a), b)
        return
      }
      withHeader(() => run(a, b))
      // The newer drawing API has no row range. Skip the header for the body
      // pass, reusing the native buffers and restoring the row synchronously.
      const rows = cells()
      if (!rows.length) return
      const header = rows[0]
      rows[0] = []
      try { return run(a, b) }
      finally { rows[0] = header }
    },
    restore: () => undo.forEach(restore => restore()),
  }
}

// Keep OpenTUI's table text buffers, layout, wrapping and selection. Decorate
// changed cells once, and fill each cell's interior without painting the grid.
export function createTables() {
  const states = new Map<TextTableRenderable, State>()
  const stats = { attached: 0, cells: 0, updates: 0 }
  let palette: Appearance

  function layout(table: TextTableRenderable) {
    table.columnWidthMode = "full"
    table.cellPaddingX = 2
    table.cellPaddingY = 0
    table.columnGap = 0
    table.border = true
    table.outerBorder = true
    table.showBorders = true
    table.borderColor = palette.border
  }

  function decorate(table: TextTableRenderable) {
    layout(table)
    if (states.has(table)) return
    const content = Object.getOwnPropertyDescriptor(TextTableRenderable.prototype, "content")
    const paintKey = typeof Reflect.get(table, "drawCellRange") === "function" ? "drawCellRange" : "drawCells"
    const paint = Reflect.get(table, paintKey)
    if (!content?.get || !content.set || typeof paint !== "function") return
    const ownContent = Object.getOwnPropertyDescriptor(table, "content")
    const ownPaint = Object.getOwnPropertyDescriptor(table, paintKey)
    const header = padHeader(table, paintKey === "drawCellRange")
    const background = (row: number) => row === 0 ? palette.header : palette.row
    const state: State = {
      source: table.content, cells: new WeakMap(),
      update() {
        stats.updates++
        const styled = state.source.map((row, rowIndex) => row.map(cell => {
          const role = rowIndex === 0 ? 0 : 1
          const cached = cell && state.cells.get(cell)?.get(role)
          if (cached) return cached
          const result = (cell ?? []).map(chunk => {
            // Native inline-code spans already carry their own background.
            // Keep the code chip distinct from the cell's background.
            const explicit = chunk.bg && chunk.bg.a > 0
            const code = explicit && chunk.fg?.equals(palette.code)
            return {
              ...chunk, bg: code ? palette.tableCode : explicit ? chunk.bg : background(rowIndex),
              ...(rowIndex === 0 ? { fg: palette.heading, attributes: (chunk.attributes ?? 0) | 1 } : {}),
            }
          })
          if (cell) {
            let roles = state.cells.get(cell)
            if (!roles) state.cells.set(cell, roles = new Map())
            roles.set(role, result)
          }
          stats.cells++
          return result
        }))
        content.set!.call(table, styled)
      },
      restore() {
        if (table.isDestroyed) return
        if (ownContent) Object.defineProperty(table, "content", ownContent)
        else Reflect.deleteProperty(table, "content")
        if (ownPaint) Object.defineProperty(table, paintKey, ownPaint)
        else Reflect.deleteProperty(table, paintKey)
        header.restore()
        content.set!.call(table, state.source)
      },
    }
    Object.defineProperty(table, "content", {
      configurable: true,
      get: () => content.get!.call(table),
      set(value: Content) { state.source = value; state.update() },
    })
    Reflect.set(table, paintKey, function(buffer: OptimizedBuffer, a = 0, b = 0) {
      const measured = Reflect.get(table, "_layout") as Layout
      const range = paintKey === "drawCellRange"
      const first = range ? a : 0
      const last = range ? b : measured.rowHeights.length - 1
      const x = range ? 0 : a
      const y = range ? 0 : b
      for (let row = first; row <= last; row++) {
        const top = y + measured.rowOffsets[row] + 1
        const height = measured.rowHeights[row]
        if (top + height <= 0 || top >= buffer.height) continue
        for (let column = 0; column < measured.columnWidths.length; column++) {
          const left = x + measured.columnOffsets[column] + 1
          buffer.fillRect(left, top, measured.columnWidths[column], height, background(row))
        }
      }
      return header.draw((first, last) => Reflect.apply(paint, table, [buffer, first, last]), a, b)
    })
    states.set(table, state)
    stats.attached++
    state.update()
  }

  return {
    stats,
    decorate,
    palette(value: Appearance) {
      for (const table of states.keys()) if (table.isDestroyed) states.delete(table)
      if (palette === value) return
      palette = value
      for (const [table, state] of states) {
        table.borderColor = palette.border
        state.cells = new WeakMap()
        state.update()
        table.requestRender()
      }
    },
    attach(node: MarkdownRenderable) {
      const restore: (() => void)[] = []
      // Older native Markdown can create/update tables without renderNode.
      for (const key of ["createTextTableRenderable", "applyTableRenderableOptions", "resolveTableRenderableOptions"]) {
        const original = Reflect.get(node, key)
        if (typeof original !== "function") continue
        const own = Object.getOwnPropertyDescriptor(node, key)
        const wrapper = (...args: unknown[]) => {
          const result = Reflect.apply(original, node, args)
          if (key === "resolveTableRenderableOptions") {
            // Markdown reapplies these native options to reused tables while
            // streaming, after it has updated their content.
            return node.conceal ? { ...result, columnWidthMode: "full",
              cellPaddingX: 2, cellPaddingY: 0, columnGap: 0,
              border: true, outerBorder: true, showBorders: true, borderColor: palette.border } : result
          }
          const table = key === "createTextTableRenderable" ? result : args[0]
          if (node.conceal && table instanceof TextTableRenderable) decorate(table)
          return result
        }
        Reflect.set(node, key, wrapper)
        restore.push(() => {
          if (Reflect.get(node, key) !== wrapper) return
          if (own) Object.defineProperty(node, key, own)
          else Reflect.deleteProperty(node, key)
        })
      }
      return () => restore.forEach(undo => undo())
    },
    restore() {
      for (const state of states.values()) state.restore()
      states.clear()
    },
  }
}
