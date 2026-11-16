import { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, CodeRenderable, ImageRenderable, MarkdownRenderable, StyledText, TextRenderable, TextTableRenderable, rgbToHex, type Renderable, type Selection } from "@opentui/core"
import { writeFileSync } from "node:fs"
import { createRaster } from "./raster.mjs"
import { terminalFont } from "./font.mjs"
import { select, highlight } from "./selection.mjs"
import { prettyJSON } from "./json.mjs"
import { createTypography } from "./typography"
import { appearanceFor } from "./appearance"
import { createTables } from "./tables"

// Experimental adapter: the plugin API exposes code-block overrides but no
// heading/quote/list hook yet. Wrap the MarkdownRenderable block hook on
// existing widgets, preserving OpenCode's native transcript.
export default Plugin.define({
  id: "md",
  async setup(context) {
    const raster = createRaster()
    const attached = new Map<MarkdownRenderable, { key: string; original: unknown; wrapper: unknown; mode?: string; restoreLists?: () => void; restoreTables: () => void }>()
    const headings = new Set<Heading>()
    const quotes = new Set<BoxRenderable>()
    const styledLists = new WeakSet<Renderable>()
    const styledRows = new WeakSet<Renderable>()
    const tasks = new WeakMap<TextRenderable, boolean>()
    const lists = { layouts: 0, markers: 0, passes: 0, spacing: 0 }
    let enabled = true
    let stopped = false
    let failure = ""
    let scans = 0
    let fontFamilies: string[] = await terminalFont() ?? []
    let fontRequest = 0
    const renderer = context.renderer
    const typography = createTypography(renderer)
    const tables = createTables()
    const supported = () => renderer.capabilities?.kitty_graphics || renderer.capabilities?.image_protocol === "kitty"
    const color = () => rgbToHex(appearanceFor(context.themeMode).heading)
    const unregisterJSON = context.markdown.registerCodeBlockRenderer("json", (block, render) => {
      const code = render.defaultRender()
      if (!enabled || !render.conceal || !(code instanceof CodeRenderable)) return code
      code.content = prettyJSON(block.text)
      code.bg = context.theme.background.raised.base
      const box = new BoxRenderable(renderer, {
        width: "100%", flexDirection: "column", flexShrink: 0, padding: 1,
        backgroundColor: context.theme.background.raised.base,
      })
      box.add(new TextRenderable(renderer, {
        content: "JSON", fg: context.theme.text.muted, height: 1, marginBottom: 1, selectable: false,
      }))
      box.add(code)
      return box
    })

    class SelectableHeading extends ImageRenderable {
      private range: { start: number; end: number } | null = null
      constructor(private layout: ReturnType<typeof raster.render>, error: (error: unknown) => void) {
        super(renderer, { width: layout.columns, height: layout.rows, source: layout.png,
          fit: "fill", protocol: "kitty", onError: error })
        this.selectable = true
      }
      replace(layout: ReturnType<typeof raster.render>) {
        this.layout = layout
        this.width = layout.columns
        this.height = layout.rows
        this.range = null
        this.source = layout.png
        this.onSelectionChanged(renderer.getSelection())
      }
      shouldStartSelection(x: number, y: number) {
        return x >= this.x && x < this.x + this.width && y >= this.y && y < this.y + this.height
      }
      onSelectionChanged(selection: Selection | null) {
        const range = select(this.layout, selection, this)
        if (range?.start !== this.range?.start || range?.end !== this.range?.end) {
          this.range = range
          this.source = highlight(this.layout, range)
          this.requestRender()
        }
        return this.hasSelection()
      }
      getSelectedText() {
        return this.range ? this.layout.text.slice(this.range.start, this.range.end) : ""
      }
      hasSelection() { return this.range !== null }
    }

    class Heading extends BoxRenderable {
      private image: SelectableHeading | undefined
      private layout: ReturnType<typeof raster.render> | undefined
      private signature = ""
      private fallback: Renderable | null = null
      constructor(private text: string, private level: number, private original: () => Renderable | null) {
        super(renderer, { width: "100%", height: 1, flexShrink: 0 })
        headings.add(this)
      }
      update() {
        if (this.isDestroyed || this.width < 2) return
        // OpenTUI inserts a full Markdown row before the following block.
        // The heading already supplies its own bottom gap: cancel that extra
        // row on our node, leaving the native block and its styles untouched.
        // Recheck each frame because streaming can replace the next sibling.
        const siblings = this.parent?.getChildren() ?? []
        const index = siblings.indexOf(this)
        const stacked = siblings[index - 1] instanceof Heading
        const next = siblings[index + 1]
        // A title/subtitle group shares the preceding heading's bottom gap.
        // Don't add another full heading lead-in. Apply this even on cache
        // hits: streaming can insert/remove a paragraph between two headings.
        // Raster spacing already provides the larger top gap; omit the extra
        // Markdown row above it.
        this.marginTop = 0
        if (this.layout && !this.fallback) {
          const padding = stacked ? 0 : this.layout.paddingTop
          this.paddingTop = padding
          this.height = this.layout.rows + padding
        }
        const gap = next instanceof Heading ? 0 : next?.marginTop
        this.marginBottom = typeof gap === "number" ? -Math.max(0, gap) : 0
        const cellWidth = renderer.resolution ? renderer.resolution.width / renderer.terminalWidth : 16
        const cellHeight = renderer.resolution ? renderer.resolution.height / renderer.terminalHeight : 32
        const input = { text: this.text, level: this.level, columns: this.width,
          cellWidth: Math.max(4, Math.min(64, cellWidth)), cellHeight: Math.max(8, Math.min(128, cellHeight)),
          color: color(), background: rgbToHex(context.theme.background.base), fontFamilies }
        const signature = JSON.stringify(input)
        if (signature === this.signature) return
        this.signature = signature
        try {
          const result = raster.render(input)
          this.layout = result
          const padding = stacked ? 0 : result.paddingTop
          this.paddingTop = padding
          this.height = result.rows + padding
          if (!this.image) {
            this.image = new SelectableHeading(result, error => this.fail(error))
            this.add(this.image)
          } else {
            this.image.replace(result)
          }
        } catch (error) { this.fail(error) }
      }
      fail(error: unknown) {
        failure = String(error)
        this.image?.destroyRecursively()
        this.image = undefined
        if (!this.fallback) {
          this.fallback = this.original()
          if (this.fallback) this.add(this.fallback)
        }
        this.height = "auto"
      }
      protected destroySelf() {
        headings.delete(this)
        super.destroySelf()
      }
      inspect() {
        const node = this.image
        return node ? { x: node.x, y: node.y, width: node.width, height: node.height, text: this.text, font: this.layout?.font } : undefined
      }
    }

    // Decorate the existing native list rows only when Markdown builds/updates
    // a block. Keep their separate marker/content columns: wrapping, selection,
    // ordered starts and inline syntax remain OpenTUI's job.
    function styleLists(node: Renderable, depth = 0) {
      const rows = node.getChildren()
      const isList = node instanceof BoxRenderable && rows.length > 0 && rows.every(row => {
        const [marker, content] = row.getChildren()
        return marker instanceof TextRenderable && marker.id.endsWith("-marker") && content instanceof BoxRenderable
      })
      if (!isList) {
        for (const child of rows) styleLists(child, depth)
        return
      }
      lists.passes++
      if (!styledLists.has(node)) {
        node.paddingLeft = 2
        styledLists.add(node)
        lists.layouts++
      }
      for (const row of rows) {
        const [marker, content] = row.getChildren() as [TextRenderable, BoxRenderable]
        if (row instanceof BoxRenderable && !styledRows.has(row)) {
          row.columnGap = 1
          styledRows.add(row)
        }
        const chunks = marker.chunks
        const first = chunks[0]
        if (!first) continue
        let text = first.text.replace(/^(\s*)[-*+•◦](?=\s|$)/u, `$1${depth % 2 ? "◦" : "•"}`)
        // OpenTUI 0.8 drops checkbox tokens from native list content. Restore
        // their parsed state in the marker; newer native checkboxes pass through.
        if (tasks.has(marker)) {
          text = text.replace(/(?:\s[☑☐])?\s*$/u, ` ${tasks.get(marker) ? "☑" : "☐"} `)
          if (marker.width !== text.length) marker.width = text.length
        }
        if (text !== first.text) {
          marker.content = new StyledText([{ ...first, text }, ...chunks.slice(1)])
          lists.markers++
        }
        styleLists(content, depth + 1)
      }
      // A final item's trailing Markdown blank line is outside the list, not
      // spacing between items. Avoid retaining it as an extra bottom row.
      const last = rows[rows.length - 1]
      if (last.marginBottom !== 0) {
        last.marginBottom = 0
        lists.spacing++
      }
    }

    // 0.8 reuses lists during streaming without calling renderNode again.
    // Decorate at its native list create/update boundaries, not on scroll frames.
    // Only the outer call walks the list, after nested native updates complete.
    function attachLists(node: MarkdownRenderable) {
      const keys = ["createListRenderable", "applyListRenderable"] as const
      if (!keys.every(key => typeof Reflect.get(node, key) === "function")) return
      let nesting = 0
      const restore = keys.map(key => {
        const original = Reflect.get(node, key)
        const descriptor = Object.getOwnPropertyDescriptor(node, key)
        const wrapper = (...args: unknown[]) => {
          nesting++
          try {
            const result = Reflect.apply(original, node, args)
            const list = key === "createListRenderable" ? result : args[0]
            const token = (key === "createListRenderable" ? args[0] : args[1]) as { items?: { task?: boolean; checked?: boolean }[] }
            if (result && list instanceof BoxRenderable) {
              list.getChildren().forEach((row, index) => {
                const marker = row.getChildren()[0]
                if (!(marker instanceof TextRenderable)) return
                const item = token.items?.[index]
                if (item?.task) tasks.set(marker, item.checked === true)
                else tasks.delete(marker)
              })
              if (nesting === 1 && node.conceal) styleLists(list)
            }
            return result
          } finally {
            nesting--
          }
        }
        Reflect.set(node, key, wrapper)
        return () => {
          if (Reflect.get(node, key) !== wrapper) return
          if (descriptor) Object.defineProperty(node, key, descriptor)
          else Reflect.deleteProperty(node, key)
        }
      })
      return () => restore.forEach(undo => undo())
    }

    function restore() {
      for (const [node, saved] of attached) {
        typography.detach(node)
        if (node.isDestroyed) continue
        saved.restoreLists?.()
        saved.restoreTables()
        // Access is guarded by runtime feature detection for OpenTUI 0.8/0.9.
        Reflect.set(node, saved.key, saved.original)
        if (saved.mode !== undefined) Reflect.set(node, "internalBlockMode", saved.mode)
      }
      attached.clear()
      tables.restore()
      quotes.clear()
      raster.clear()
    }
    function scan(node: Renderable) {
      if (node.isDestroyed) return
      if (node instanceof MarkdownRenderable) {
        typography.apply(node)
        if (!attached.has(node)) {
          const key = "renderBlock" in node ? "renderBlock" : "renderNode" in node ? "renderNode" : undefined
          if (!key) { failure = "This OpenTUI version has no custom Markdown block renderer."; return }
          const original = Reflect.get(node, key)
          const restoreLists = attachLists(node)
          const restoreTables = tables.attach(node)
          const wrapper = (block: { kind?: string; type?: string; level?: number; depth?: number; text: string; tokens?: { text?: string; tokens?: unknown[] }[] },
            render: { defaultRender: () => Renderable | null; conceal: boolean }) => {
            if (!enabled || !render.conceal) return original?.(block, render)
            const kind = block.kind ?? block.type
            if (kind === "table") {
              const table = original?.(block, render) ?? render.defaultRender()
              if (table instanceof TextTableRenderable) tables.decorate(table)
              return table
            }
            if (kind === "list") {
              const list = original?.(block, render) ?? render.defaultRender()
              if (list && !restoreLists) styleLists(list)
              return list
            }
            if (kind === "quote" || kind === "blockquote") {
              const quote = original?.(block, render) ?? render.defaultRender()
              if (quote instanceof BoxRenderable) {
                quote.border = ["left"]
                quote.borderStyle = "single"
                quote.borderColor = context.theme.markdown.blockQuote
                quote.backgroundColor = context.theme.background.raised.base
                quote.shouldFill = true
                quote.paddingLeft = 2
                quote.paddingRight = 1
                quote.paddingY = 1
                quotes.add(quote)
                if (!restoreLists) styleLists(quote)
              }
              return quote
            }
            if (kind !== "heading" || !supported()) return original?.(block, render)
            // Old marked tokens contain Markdown markers; the newer parser's
            // block.text is already display text. Use nested token text on 0.8.
            const plain = (tokens: { text?: string; tokens?: unknown[] }[]): string =>
              tokens.map(token => token.tokens ? plain(token.tokens as typeof tokens) : token.text ?? "").join("")
            return new Heading(block.tokens ? plain(block.tokens) : block.text, block.level ?? block.depth ?? 1, render.defaultRender)
          }
          const mode = "internalBlockMode" in node ? Reflect.get(node, "internalBlockMode") : undefined
          attached.set(node, { key, original, wrapper, mode, restoreLists, restoreTables })
          if (mode !== undefined) Reflect.set(node, "internalBlockMode", "top-level")
          Reflect.set(node, key, wrapper)
        }
        return
      }
      for (const child of node.getChildren()) scan(child)
    }
    const frame = async () => {
      if (stopped || !enabled) return
      scans++
      const appearance = appearanceFor(context.themeMode)
      tables.palette(appearance)
      typography.palette({ text: context.theme.markdown.text, code: appearance.code, heading: appearance.heading,
        codeBackground: context.theme.background.raised.high, link: context.theme.markdown.link })
      for (const node of attached.keys()) if (node.isDestroyed) {
        typography.detach(node)
        attached.delete(node)
      }
      for (const node of quotes) if (node.isDestroyed) quotes.delete(node)
      scan(renderer.root)
      for (const heading of headings) heading.update()
    }
    const diagnostics = () => ({
      plugin: "md", enabled, supported: !!supported(), attached: attached.size, headings: headings.size,
      raster: raster.stats, scans, failure, fontFamilies, lists, typography: typography.stats, tables: tables.stats,
      headingColor: color(),
      api: Object.getOwnPropertyNames(MarkdownRenderable.prototype),
      resolution: renderer.resolution,
      selection: renderer.getSelection()?.getSelectedText() ?? "",
      quotes: [...quotes].map(node => ({ x: node.x, y: node.y, width: node.width, height: node.height,
        border: node.border, background: rgbToHex(node.backgroundColor) })),
      nodes: [...headings].map(node => ({ x: node.x, y: node.y, width: node.width, height: node.height, image: node.inspect() })),
    })
    const dump = () => {
      if (typeof context.options.diagnostics === "string") writeFileSync(context.options.diagnostics, JSON.stringify(diagnostics()))
    }
    renderer.setFrameCallback(frame)
    renderer.on("frame", dump)
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "md.toggle", title: "Toggle Markdown styling (md)", group: "Appearance",
        palette: true, slash: { name: "md", arguments: true },
        run: async (input?: string) => {
          const value = input?.trim()
          if (value === "status") {
            context.ui.toast.show({ message: `md ${enabled ? "on" : "off"} · ${supported() ? "large" : "native"} headings · ${fontFamilies.join(", ") || "monospace"} · ${raster.stats.renders} rasterized · ${failure || "ready"}` })
            dump()
            return
          }
          if (value && value !== "on" && value !== "off") {
            context.ui.toast.show({ message: "Use /md, /md on, /md off, or /md status." })
            return
          }
          const next = value === "on" ? true : value === "off" ? false : !enabled
          const request = ++fontRequest
          if (next && supported()) {
            const families = await terminalFont()
            if (stopped || request !== fontRequest) return
            if (families) fontFamilies = families
          }
          if (next !== enabled) {
            enabled = next
            restore()
          }
          context.ui.toast.show({ message: enabled
            ? "md on · Markdown styling enabled"
            : "md off · native Markdown restored" })
          renderer.requestRender()
          dump()
        },
      }],
    }))
    dump()
    return () => {
      stopped = true
      unregisterJSON()
      renderer.removeFrameCallback(frame)
      renderer.off("frame", dump)
      restore()
    }
  },
})
