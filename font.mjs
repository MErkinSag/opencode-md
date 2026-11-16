import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

// Ask Ghostty for its effective configuration, including includes and macOS/XDG
// precedence. Run only when enabling/refreshing headings, never during a frame.
export async function terminalFont() {
  try {
    const { stdout } = await exec("ghostty", ["+show-config"], {
      encoding: "utf8", timeout: 2000, maxBuffer: 256 * 1024,
    })
    const families = []
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^font-family\s*=\s*(.*?)\s*$/.exec(line)
      if (!match) continue
      const family = match[1].replace(/^"(.*)"$/, "$1")
      if (family) families.push(family)
      else families.length = 0
    }
    return families.length ? families : undefined
  } catch {
    // Keep the last resolved family, or the rasterizer's monospace fallback.
    return undefined
  }
}
