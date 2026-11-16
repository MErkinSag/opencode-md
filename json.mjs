// Change whitespace only: JSON.parse/stringify would round large integers,
// discard duplicate keys, reorder numeric keys, and rewrite escaped strings.
export function prettyJSON(source) {
  if (source.length > 1_000_000) return source
  try { JSON.parse(source) } catch { return source }
  const tokens = source.match(/"(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g) ?? []
  const output = []
  let depth = 0
  let length = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    let part = token
    if (token === "{" || token === "[") {
      depth++
      if (depth > 100) return source
      if (tokens[i + 1] !== (token === "{" ? "}" : "]")) part += "\n" + "  ".repeat(depth)
    } else if (token === "}" || token === "]") {
      depth--
      if (tokens[i - 1] !== (token === "}" ? "{" : "[")) part = "\n" + "  ".repeat(depth) + token
    } else if (token === ",") {
      part += "\n" + "  ".repeat(depth)
    } else if (token === ":") {
      part += " "
    }
    length += part.length
    if (length > 4_000_000) return source
    output.push(part)
  }
  return output.join("")
}
