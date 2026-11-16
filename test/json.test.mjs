import { test } from "node:test"
import assert from "node:assert/strict"
import { prettyJSON } from "../json.mjs"

test("formats JSON structures without changing number/string/key tokens", () => {
  const source = String.raw`{"2":9007199254740993,"1":-0,"2":1e400,"escaped":"\u0061\"\\","empty":[{},[]]}`
  const formatted = prettyJSON(source)
  assert.equal(formatted, String.raw`{
  "2": 9007199254740993,
  "1": -0,
  "2": 1e400,
  "escaped": "\u0061\"\\",
  "empty": [
    {},
    []
  ]
}`)
  assert.equal(prettyJSON(formatted), formatted)
})

test("preserves incomplete/invalid JSON while streaming", () => {
  for (const text of ['{"message":"hel', '{"value":', '{"value":1,}', '{"value":NaN}', '{/* comment */"a":1}']) {
    assert.equal(prettyJSON(text), text)
  }
  assert.equal(prettyJSON('{"value":[1,true,null]}'), '{\n  "value": [\n    1,\n    true,\n    null\n  ]\n}')
  assert.equal(prettyJSON(' " spaced string " '), '" spaced string "')
})

test("large or excessively nested blocks retain original text", () => {
  const large = JSON.stringify({ text: "x".repeat(1_000_001) })
  assert.equal(prettyJSON(large), large)
  const deep = "[".repeat(101) + "1" + "]".repeat(101)
  assert.equal(prettyJSON(deep), deep)
})
