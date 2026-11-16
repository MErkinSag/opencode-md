// Test-only fixture driver: edits the disposable session's mounted widget,
// never server data, to exercise the real Markdown streaming renderer.
import { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, CodeRenderable, MarkdownRenderable, TextRenderable, TextTableRenderable, rgbToHex, type OptimizedBuffer } from "@opentui/core"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
export default Plugin.define({
  id: "md-stream-test",
  setup(context) {
    let timer: ReturnType<typeof setInterval> | undefined
    const capabilities = Object.getOwnPropertyDescriptor(context.renderer, "capabilities")
    let painted: { text: string; fg: string; bg: string; attributes: number }[][] = []
    const capture = (buffer: OptimizedBuffer) => {
      painted = buffer.getSpanLines().map(line => line.spans.map(span => ({
        text: span.text, fg: rgbToHex(span.fg), bg: rgbToHex(span.bg), attributes: span.attributes,
      })))
    }
    context.renderer.addPostProcessFn(capture)
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "md-stream-test.run", title: "Fixture streaming", slash: { name: "md-test", arguments: true },
        run(input?: string) {
          function find(node) {
            if (node instanceof MarkdownRenderable && node.content.includes("NATIVE_BODY_SENTINEL")) return node
            for (const child of node.getChildren()) {
              const value = find(child)
              if (value) return value
            }
          }
          const node = find(context.renderer.root)
          if (!node) throw new Error("Fixture Markdown missing")
          if (input?.trim() === "native") {
            // Exercise the same plugin on a terminal without image support.
            Object.defineProperty(context.renderer, "capabilities", {
              configurable: true,
              value: { ...context.renderer.capabilities, kitty_graphics: false, image_protocol: "blocks" },
            })
            return
          }
          if (input?.trim() === "tables") {
            node.tableOptions = { ...node.tableOptions, style: "grid" }
            node.content = readFileSync(new URL("../tables.md", import.meta.url), "utf8")
            return
          }
          if (input?.trim() === "table-append") {
            node.streaming = true
            node.content += "| ROW_FIVE | STREAMED"
            timer = setInterval(() => {
              node.content += " | 5 |\n| ROW_SIX | Final row | 6 |\n"
              node.streaming = false
              clearInterval(timer)
            }, 30)
            return
          }
          if (input?.trim() === "table-header") {
            node.content = node.content.replace("| Name | Notes | Value |",
              "| Name | Notes with a deliberately long column title that wraps across several terminal lines and ends HEADER_END | Value |")
            return
          }
          if (input?.trim() === "inline") {
            node.content = readFileSync(new URL("../inline.md", import.meta.url), "utf8")
            return
          }
          if (input?.trim() === "inline-append") {
            node.streaming = true
            node.content += "\n\nINLINE_STREAM **STREAM_BOLD"
            timer = setInterval(() => {
              node.content += "** *STREAM_ITALIC* `STREAM_CODE` [STREAM_LINK](https://example.com).\n"
              node.streaming = false
              clearInterval(timer)
            }, 30)
            return
          }
          if (input?.trim() === "lists") {
            node.content = readFileSync(new URL("../lists.md", import.meta.url), "utf8")
            return
          }
          if (input?.trim() === "list-append") {
            node.streaming = true
            node.content += "\n\n- STREAMED_BULLET"
            let count = 0
            timer = setInterval(() => {
              node.content += count++ === 0
                ? " stays native.\n- STREAMED_SECOND\n\n9. STREAMED_NINE"
                : " stays numbered.\n10. STREAMED_TEN\n"
              if (count === 2) {
                node.streaming = false
                clearInterval(timer)
              }
            }, 30)
            return
          }
          if (input?.trim() === "task-toggle") {
            node.content = node.content.replace("- [ ] TASK_OPEN", "- [x] TASK_OPEN")
            return
          }
          if (input?.trim() === "source" || input?.trim() === "conceal") {
            node.conceal = input.trim() === "conceal"
            return
          }
          if (input?.trim() === "separate") {
            node.content = node.content.replace("# Elegant OpenCode\n\n## Paired subtitle",
              "# Elegant OpenCode\n\nIntervening paragraph.\n\n## Paired subtitle")
            return
          }
          if (input?.trim() === "join") {
            node.content = node.content.replace("# Elegant OpenCode\n\nIntervening paragraph.\n\n## Paired subtitle",
              "# Elegant OpenCode\n\n## Paired subtitle")
            return
          }
          node.streaming = true
          let count = 0
          timer = setInterval(() => {
            node.content += count === 0 ? "\n\n## Streaming heading" : count < 8 ? ` ${count}`
              : count === 8 ? '\n\n```json\n{"streamed":'
              : count === 9 ? 'true,"number":9007199254740993}\n```\n'
              : count === 10 ? "\n\n> STREAM_QUOTE"
              : count === 11 ? " stays native.\n\n"
              : "\n\nStreaming native text."
            count++
            if (count === 20) {
              clearInterval(timer)
              node.streaming = false
            }
          }, 30)
        },
      }],
    }))
    if (typeof context.options.ready === "string") writeFileSync(context.options.ready, "ready")
    // The external PTY test can read during a frame; publish complete snapshots.
    const snapshot = (path: string, value: string) => {
      writeFileSync(path + ".tmp", value)
      renameSync(path + ".tmp", path)
    }
    const inspect = () => {
      if (typeof context.options.ready !== "string") return
      const codes: { content: string; height: number; filetype?: string; destroyed: boolean }[] = []
      const quotes: { content: string; x: number; y: number; width: number; height: number }[] = []
      const spacing: { top: number; following: number; stacked: boolean; inset: number }[] = []
      const listSpacing: { before?: number; after?: number; first: string }[] = []
      const inline: unknown[] = []
      const tables: unknown[] = []
      const nativeHeadings: unknown[] = []
      const lists: { marker: string; x: number; textX: number; listX: number; y: number; width: number; body: { content: string; x: number; y: number; height: number }[] }[] = []
      function visit(node) {
        if (node instanceof CodeRenderable && node.content.includes("TABLE_HEADING")) {
          nativeHeadings.push(painted.slice(Math.max(0, node.y), Math.max(0, node.y + node.height)).flat())
        }
        if (node instanceof TextTableRenderable) {
          const measured = Reflect.get(node, "_layout")
          tables.push({ x: node.x, y: node.y, width: node.width, height: node.height,
            rowOffsets: measured.rowOffsets, rowHeights: measured.rowHeights,
            columnOffsets: measured.columnOffsets, columnWidths: measured.columnWidths,
            padding: node.cellPaddingX, paddingY: node.cellPaddingY,
            borders: node.border && node.outerBorder && node.showBorders,
            borderColor: rgbToHex(node.borderColor),
            rows: node.content.map(row => row.map(cell => cell?.map(chunk => chunk.text).join("") ?? "")),
            painted: painted.slice(Math.max(0, node.y), Math.max(0, node.y + node.height)),
          })
        }
        if (node instanceof CodeRenderable && node.filetype === "markdown" && node.content.includes("INLINE_")) {
          inline.push({ content: node.content, plainText: node.plainText, x: node.x, y: node.y,
            chunks: painted.slice(Math.max(0, node.y), Math.max(0, node.y + node.height)).flat() })
        }
        if (node instanceof TextRenderable && node.id.endsWith("-marker")) {
          const row = node.parent
          const content = row?.getChildren()[1]
          if (content instanceof BoxRenderable) {
            const body: { content: string; x: number; y: number; height: number }[] = []
            function texts(child) {
              if (child instanceof CodeRenderable)
                body.push({ content: child.content, x: child.x, y: child.y, height: child.height })
              for (const nested of child.getChildren()) texts(nested)
            }
            texts(content)
            lists.push({ marker: node.chunks.map(chunk => chunk.text).join(""), x: node.x,
              textX: content.x, listX: row.parent.x, y: node.y, width: node.width, body })
          }
        }
        if (node instanceof MarkdownRenderable) {
          const children = node.getChildren()
          children.forEach((child, index) => {
            const next = children[index + 1]
            const rows = child.getChildren()
            const marker = rows[0]?.getChildren()[0]
            if (marker instanceof TextRenderable && marker.id.endsWith("-marker")) {
              const previous = children[index - 1]
              const last = rows[rows.length - 1]
              listSpacing.push({
                before: previous ? rows[0].y - previous.y - previous.height : undefined,
                after: next ? next.y - last.y - last.height : undefined,
                first: marker.chunks.map(chunk => chunk.text).join(""),
              })
            }
            if (child.constructor.name === "Heading" && next)
              spacing.push({ top: child.marginTop, following: next.y - child.y - child.height,
                stacked: children[index - 1]?.constructor.name === "Heading",
                inset: child.getChildren()[0]?.y - child.y })
          })
        }
        if (node instanceof CodeRenderable && node.filetype === "json")
          codes.push({ content: node.content, height: node.height, filetype: node.filetype, destroyed: node.isDestroyed })
        if (node instanceof CodeRenderable && (node.content.includes("QUOTED_TEXT") || node.content.includes("STREAM_QUOTE")))
          quotes.push({ content: node.content, x: node.x, y: node.y, width: node.width, height: node.height })
        for (const child of node.getChildren()) visit(child)
      }
      visit(context.renderer.root)
      snapshot(context.options.ready + ".json", JSON.stringify(codes))
      snapshot(context.options.ready + ".quotes.json", JSON.stringify(quotes))
      snapshot(context.options.ready + ".spacing.json", JSON.stringify(spacing))
      snapshot(context.options.ready + ".lists.json", JSON.stringify(lists))
      snapshot(context.options.ready + ".list-spacing.json", JSON.stringify(listSpacing))
      snapshot(context.options.ready + ".tables.json", JSON.stringify({
        tables, nativeHeadings, background: rgbToHex(context.theme.background.base),
      }))
      snapshot(context.options.ready + ".inline.json", JSON.stringify({
        palette: { text: rgbToHex(context.theme.markdown.text), codeBackground: rgbToHex(context.theme.background.raised.high),
          link: rgbToHex(context.theme.markdown.link) },
        nodes: inline,
      }))
    }
    context.renderer.on("frame", inspect)
    return () => {
      clearInterval(timer)
      if (capabilities) Object.defineProperty(context.renderer, "capabilities", capabilities)
      else Reflect.deleteProperty(context.renderer, "capabilities")
      context.renderer.removePostProcessFn(capture)
      context.renderer.off("frame", inspect)
    }
  },
})
