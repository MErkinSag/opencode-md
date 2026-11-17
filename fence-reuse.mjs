// The renderNode-era engine recreates custom blocks on every changed token.
// Borrow an owned panel's code buffer only inside md's own defaultRender call,
// while the *native* factory invokes the render callbacks again. Arbitrary
// callbacks keep fresh defaults, including properties the updater cannot reset.
// Native reconciliation still owns ordering, removals,
// third-party replacements, forced style refreshes and source-mode changes.
// Newer renderBlock engines (or unfamiliar private APIs) keep their usual path.
export function attachFenceReuse(node, panels, update, canBorrow) {
  const keys = ["updateTopLevelBlocks", "buildTopLevelRenderBlocks",
    "createTopLevelRenderable", "createCodeRenderable", "applyCodeBlockRenderable"]
  if ("renderBlock" in node || !keys.every(key => typeof node[key] === "function")
    || !Array.isArray(node._blockStates)) return () => {}
  const originals = Object.fromEntries(keys.map(key => [key, node[key]]))
  const descriptors = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(node, key)]))
  let transaction
  let borrowed

  const wrappers = {
    updateTopLevelBlocks(...args) {
      const previous = transaction
      transaction = !args[1] && node.conceal ? new Map() : undefined
      try { return originals.updateTopLevelBlocks.apply(node, args) }
      finally {
        // Normally native reconciliation consumes every staged replacement.
        // An exception must not leak one created earlier in the same update.
        for (const result of transaction?.values() ?? []) {
          if (!result.renderable?.parent) result.renderable?.destroyRecursively()
        }
        transaction = previous
      }
    },
    buildTopLevelRenderBlocks(...args) {
      const blocks = originals.buildTopLevelRenderBlocks.apply(node, args)
      if (!transaction || !Array.isArray(blocks)) return blocks
      for (const [index, block] of blocks.entries()) {
        const state = node._blockStates[index]
        const code = state && panels.get(state.renderable)
        if (!code || code.isDestroyed || state.renderable.isDestroyed || code.parent !== state.renderable
          || state.canUpdateInPlace === true || block.token?.type !== "code"
          || state.token?.type !== "code" || state.token.lang !== block.token.lang
          || state.tokenRaw === block.token.raw) continue
        const previous = borrowed
        borrowed = { code, token: block.token }
        let result
        try { result = originals.createTopLevelRenderable.call(node, block, index) }
        finally { borrowed = previous }
        if (result.renderable === state.renderable) {
          // The usual token-equality branch now retains the updated panel.
          // Leave margin synchronization to native reconciliation.
          state.token = block.token
          state.tokenRaw = block.token.raw
        } else {
          // A third-party renderer changed its result. Feed that exact result
          // back to native reconciliation, without invoking the callback twice.
          transaction.set(index, result)
        }
      }
      return blocks
    },
    createTopLevelRenderable(block, index) {
      const result = transaction?.get(index)
      if (!result) return originals.createTopLevelRenderable.call(node, block, index)
      transaction.delete(index)
      return result
    },
    createCodeRenderable(token, ...args) {
      if (!borrowed || token !== borrowed.token || !canBorrow())
        return originals.createCodeRenderable.call(node, token, ...args)
      const { code } = borrowed
      // Consume once: a renderer calling defaultRender twice still gets a
      // distinct second default widget, just as it does without the adapter.
      borrowed = undefined
      update(code, token, value => originals.applyCodeBlockRenderable.call(node, code, value, 0))
      return code
    },
  }
  for (const [key, wrapper] of Object.entries(wrappers)) node[key] = wrapper
  return () => {
    for (const [key, wrapper] of Object.entries(wrappers)) {
      if (node[key] !== wrapper) continue
      if (descriptors[key]) Object.defineProperty(node, key, descriptors[key])
      else delete node[key]
    }
  }
}
