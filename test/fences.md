NATIVE_BODY_SENTINEL

```text
FENCE_TEXT
  **keep literal** and `backticks`
```

```
FENCE_BARE
  exact spaces
```

```javascript
const FENCE_JS = "native";
```

```json
{"name":"FENCE_JSON","nested":{"ready":true}}
```

```jsonc
{ // FENCE_JSONC
  "ready": true
}
```

```madeuplang
FENCE_UNKNOWN stays literal.
```
