"""Open a small demonstration in a separate Ghostty-backed cmux workspace."""
import json
import subprocess
import shlex
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def api(method, path, body):
    raw = subprocess.check_output(["opencode", "api", method, path, "--data", json.dumps(body)], text=True)
    value = json.loads(raw)
    return value.get("data", value)

seed = api("post", "/api/session", {"title": "md plugin demo", "location": {"directory": str(ROOT)}})
info = {**seed, "id": seed["id"] + "-demo"}
text = """# Elegant OpenCode

This paragraph is **native terminal text**. You can select it normally.
The enlarged headings use small cached images.

## A lighter Markdown experience

- Native scrolling and code highlighting.
- Original OpenCode tools, input, and menus.
- No Chromium process or full-page screenshots.

### Code stays native

```python
def hello():
    return "Small images, native text"
```

Use `/md off` to compare, and `/md on` to restore all Markdown styling.
"""
session = api("post", "/api/experimental/session/import", {"info": info, "location": info["location"], "messages": [
    {"id": "msg_demo_user", "type": "user", "time": {"created": 1}, "text": "Show me the md plugin."},
    {"id": "msg_demo_assistant", "type": "assistant", "time": {"created": 2, "completed": 3},
     "agent": "general", "model": {"providerID": "openai", "id": "gpt-6-astra"},
     "content": [{"type": "text", "text": text}]},
]})
subprocess.run(["opencode", "api", "delete", "/api/session/" + seed["id"]], check=True)
config = {"plugins": [{"package": str(ROOT), "options": {"diagnostics": str(ROOT / "artifacts/live.json")}}],
          "highlights": False, "attention": {"notifications": False, "sound": False}}
command = "env OPENCODE_CLI_CONFIG_CONTENT=" + shlex.quote(json.dumps(config)) + " opencode --session " + session["id"] + " " + str(ROOT)
result = subprocess.check_output(["cmux", "--json", "new-workspace", "--name", "OpenCode · md", "--cwd", str(ROOT), "--command", command], text=True)
(ROOT / "artifacts/demo.json").write_text(json.dumps({"session": session["id"], "workspace": result}, indent=2))
print(result)
