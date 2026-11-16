import { RGBA } from "@opentui/core"

const light = {
  heading: RGBA.fromHex("#000000"),
  code: RGBA.fromHex("#d6336c"),
  header: RGBA.fromHex("#e5e7eb"),
  row: RGBA.fromHex("#ffffff"),
  tableCode: RGBA.fromHex("#f5f5f5"),
  border: RGBA.fromHex("#d1d5db"),
}
const dark = {
  heading: RGBA.fromHex("#fafafa"),
  code: RGBA.fromHex("#fb7185"),
  header: RGBA.fromHex("#3f3f46"),
  row: RGBA.fromHex("#18181b"),
  tableCode: RGBA.fromHex("#27272a"),
  border: RGBA.fromHex("#52525b"),
}

export const appearanceFor = (mode: string) => mode === "dark" ? dark : light
export type Appearance = ReturnType<typeof appearanceFor>
