import test from "node:test"
import assert from "node:assert/strict"
import { attachFenceReuse } from "../fence-reuse.mjs"

function fixture() {
  const panels = new WeakMap()
  const boxes = new WeakMap()
  const counts = { created: 0, callbacks: 0, updates: 0 }
  const widget = () => ({
    parent: null, isDestroyed: false,
    destroyRecursively() { this.isDestroyed = true; this.code?.destroyRecursively() },
  })
  let custom
  let canBorrow = false
  const node = {
    conceal: true, _blockStates: [],
    createCodeRenderable(token) {
      counts.created++
      return Object.assign(widget(), { content: token.text, selection: "retained", wrapMode: "word" })
    },
    applyCodeBlockRenderable(code, token) { counts.updates++; code.content = token.text },
    buildTopLevelRenderBlocks(tokens) { return tokens.map(token => ({ token, marginTop: 1 })) },
    createTopLevelRenderable(block) {
      counts.callbacks++
      // Model the native factory calling an arbitrary registered renderer.
      const render = () => this.createCodeRenderable(block.token)
      let code
      if (custom) code = custom(block.token, render)
      else {
        canBorrow = true
        try { code = render() }
        finally { canBorrow = false }
      }
      if (code.foreign || !this.conceal) return { renderable: code, canUpdateInPlace: false }
      let box = boxes.get(code)
      if (!box) {
        box = Object.assign(widget(), { code })
        boxes.set(code, box)
        if (!custom) panels.set(box, code)
        code.parent = box
      }
      return { renderable: box, canUpdateInPlace: false }
    },
    updateTopLevelBlocks(tokens, force = false) {
      const blocks = this.buildTopLevelRenderBlocks(tokens)
      for (const [index, block] of blocks.entries()) {
        const old = this._blockStates[index]
        if (old && !force && old.token === block.token) continue
        old?.renderable.destroyRecursively()
        const result = this.createTopLevelRenderable(block, index)
        result.renderable.parent = this
        this._blockStates[index] = { ...result, token: block.token, tokenRaw: block.token.raw }
      }
      while (this._blockStates.length > blocks.length) this._blockStates.pop().renderable.destroyRecursively()
    },
  }
  const original = node.updateTopLevelBlocks
  const restore = attachFenceReuse(node, panels, (code, token, apply) => apply(token), () => canBorrow)
  const token = (text, lang = "text") => ({ type: "code", lang, text, raw: `\`\`\`${lang}\n${text}` })
  return { node, counts, restore, original, token, custom: fn => { custom = fn }, widget }
}

test("streamed fences retain their native buffer, panel and selection; callbacks still run", () => {
  const { node, counts, token } = fixture()
  node.updateTopLevelBlocks([token("one")])
  const panel = node._blockStates[0].renderable
  for (let index = 0; index < 80; index++) node.updateTopLevelBlocks([token(`one ${index}`)])
  assert.equal(node._blockStates[0].renderable, panel)
  assert.equal(panel.code.content, "one 79")
  assert.equal(panel.code.selection, "retained")
  assert.equal(panel.isDestroyed, false)
  assert.deepEqual(counts, { created: 1, callbacks: 81, updates: 80 })
  node.updateTopLevelBlocks([])
  assert.equal(panel.isDestroyed, true)
  assert.equal(panel.code.isDestroyed, true)
})

test("content-dependent third-party replacement runs once and stays under native ownership", () => {
  const f = fixture()
  f.node.updateTopLevelBlocks([f.token("one")])
  const panel = f.node._blockStates[0].renderable
  f.custom((token, render) => token.text === "custom"
    ? Object.assign(f.widget(), { foreign: true }) : render())
  f.node.updateTopLevelBlocks([f.token("custom")])
  const replacement = f.node._blockStates[0].renderable
  assert.equal(replacement.foreign, true)
  assert.equal(replacement.isDestroyed, false)
  assert.equal(panel.isDestroyed, true)
  assert.equal(f.counts.callbacks, 2)
  f.node.updateTopLevelBlocks([f.token("native again")])
  assert.equal(replacement.isDestroyed, true)
  assert.equal(f.counts.callbacks, 3)
})

test("default-delegating renderers keep fresh-default semantics for conditional customizations", () => {
  const f = fixture()
  const observed = []
  f.custom((token, render) => {
    observed.push(token.text)
    const code = render()
    code.annotation = token.text
    if (token.text.length < 5) code.wrapMode = "none"
    return code
  })
  f.node.updateTopLevelBlocks([f.token("one")])
  const panel = f.node._blockStates[0].renderable
  f.node.updateTopLevelBlocks([f.token("longer")])
  assert.deepEqual(observed, ["one", "longer"])
  const updated = f.node._blockStates[0].renderable
  assert.equal(updated.code.annotation, "longer")
  assert.equal(updated.code.wrapMode, "word")
  assert.equal(panel.isDestroyed, true)
  assert.notEqual(updated, panel)
})

test("a newly registered foreign callback cannot borrow a previously owned native buffer", () => {
  const f = fixture()
  f.node.updateTopLevelBlocks([f.token("one")])
  const owned = f.node._blockStates[0].renderable
  f.custom((token, render) => render())
  f.node.updateTopLevelBlocks([f.token("longer")])
  assert.notEqual(f.node._blockStates[0].renderable.code, owned.code)
  assert.equal(owned.isDestroyed, true)
  assert.equal(f.counts.updates, 0)
})

test("language, forced style refresh and source-mode changes use native replacement", () => {
  const f = fixture()
  f.node.updateTopLevelBlocks([f.token("one")])
  let previous = f.node._blockStates[0].renderable
  f.node.updateTopLevelBlocks([f.token("one", "json")])
  assert.equal(previous.isDestroyed, true)
  previous = f.node._blockStates[0].renderable
  f.node.updateTopLevelBlocks([f.token("two", "json")], true)
  assert.equal(previous.isDestroyed, true)
  previous = f.node._blockStates[0].renderable
  f.node.conceal = false
  f.node.updateTopLevelBlocks([f.token("source", "json")], true)
  assert.equal(previous.isDestroyed, true)
  assert.equal(f.node._blockStates[0].renderable.content, "source")
  assert.equal(f.counts.updates, 0)
})

test("detach restores descriptors and preserves subsequently installed wrappers", () => {
  const f = fixture()
  const later = () => {}
  f.node.createCodeRenderable = later
  f.restore()
  assert.equal(f.node.updateTopLevelBlocks, f.original)
  assert.equal(f.node.createCodeRenderable, later)
  const unsupported = { renderBlock() {}, updateTopLevelBlocks() {} }
  const before = Object.getOwnPropertyDescriptors(unsupported)
  attachFenceReuse(unsupported, new WeakMap(), () => {})()
  assert.deepEqual(Object.getOwnPropertyDescriptors(unsupported), before)
})
