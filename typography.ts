import { SyntaxStyle, rgbToHex, type CliRenderer, type MarkdownRenderable, type RGBA, type StyleDefinition } from "@opentui/core"

type Palette = { text: RGBA; code: RGBA; codeBackground: RGBA; link: RGBA; heading: RGBA }
type Entry = { source: SyntaxStyle; style: SyntaxStyle; key: string; users: number }

// Share a private native style table across Markdown widgets using the same
// source theme. Never mutate OpenCode's shared syntax theme or reparse text.
export function createTypography(renderer: CliRenderer) {
  const cache = new Map<SyntaxStyle, Entry>()
  const bound = new Map<MarkdownRenderable, Entry>()
  const stats = { created: 0, assigned: 0, disposed: 0 }
  let palette: Palette
  let key = ""

  function release(entry: Entry) {
    if (--entry.users > 0) return
    if (cache.get(entry.source) === entry) cache.delete(entry.source)
    // Child text buffers must finish the frame that replaces their styles.
    void renderer.idle().then(() => {
      entry.style.destroy()
      stats.disposed++
    })
  }

  function detach(node: MarkdownRenderable) {
    const entry = bound.get(node)
    if (!entry) return
    if (!node.isDestroyed && node.syntaxStyle === entry.style) {
      node.syntaxStyle = entry.source
      node.requestRender()
    }
    bound.delete(node)
    release(entry)
  }

  function apply(node: MarkdownRenderable) {
    if (node.isDestroyed) { detach(node); return }
    const previous = bound.get(node)
    const current = node.syntaxStyle
    const source = previous && current === previous.style ? previous.source : current
    if (!source || !key) return
    if (previous && current === previous.style && previous.key === key) return
    let entry = cache.get(source)
    if (!entry || entry.key !== key) {
      const styles = new Map(source.getAllStyles())
      const change = (name: string, value: StyleDefinition) =>
        styles.set(name, { ...styles.get(name), ...value })
      // Keep fenced-code styling independent of the inline-code background.
      if (!styles.has("markup.raw.block")) {
        styles.set("markup.raw.block", { ...source.getStyle("markup.raw") })
      }
      change("markup.strong", { fg: palette.text, bold: true })
      change("markup.bold", { fg: palette.text, bold: true })
      change("markup.italic", { fg: palette.text, italic: true })
      change("markup.raw", { fg: palette.code, bg: palette.codeBackground })
      change("markup.raw.inline", { fg: palette.code, bg: palette.codeBackground })
      for (const name of ["markup.heading", ...Array.from({ length: 6 }, (_, index) => `markup.heading.${index + 1}`)]) {
        change(name, { fg: palette.heading, bold: true })
      }
      for (const name of new Set(["markup.link", "markup.link.label", "markup.link.url",
        ...styles.keys()].filter(name => name === "markup.link" || name.startsWith("markup.link.")))) {
        change(name, { fg: palette.link })
      }
      entry = { source, key, users: 0,
        style: SyntaxStyle.fromStyles(Object.fromEntries(styles), renderer.nativeScene) }
      cache.set(source, entry)
      stats.created++
    }
    entry.users++
    bound.set(node, entry)
    node.syntaxStyle = entry.style
    node.requestRender()
    stats.assigned++
    if (previous) release(previous)
  }

  return {
    stats,
    palette(value: Palette) {
      palette = value
      key = [value.text, value.code, value.codeBackground, value.link, value.heading].map(rgbToHex).join("/")
    },
    apply,
    detach,
  }
}
