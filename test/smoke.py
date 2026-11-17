"""Exercise the installed OpenCode binary on a private PTY, without model calls."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import time

ROOT = Path(__file__).resolve().parents[1]
MODE = os.environ.get("MD_TEST_THEME_MODE", "light")
HEADING = "#fafafa" if MODE == "dark" else "#000000"
INLINE_CODE = "#fb7185" if MODE == "dark" else "#d6336c"
TABLE_HEADER = "#3f3f46" if MODE == "dark" else "#e5e7eb"
TABLE_WHITE = "#18181b" if MODE == "dark" else "#ffffff"
TABLE_CODE_BG = "#27272a" if MODE == "dark" else "#f5f5f5"
ART = Path(os.environ.get("MD_TEST_ARTIFACTS", ROOT / "artifacts"))
ART.mkdir(exist_ok=True, parents=True)
DIAG = ART / "diagnostics.json"
DIAG.unlink(missing_ok=True)
READY = ART / "driver.ready"
READY.unlink(missing_ok=True)

def api(method, path, body=None):
    command = ["opencode", "api", method, path]
    if body is not None:
        command += ["--data", json.dumps(body)]
    raw = subprocess.check_output(command, text=True)
    if not raw.strip():
        return None
    value = json.loads(raw)
    return value.get("data", value) if isinstance(value, dict) else value

info = api("post", "/api/session", {"title": "md plugin verification (retained)", "location": {"directory": str(ROOT)}})
session = None
child = None
master = None
output = bytearray()
try:
    seed = info["id"]
    info["id"] += "-md"
    text = "# Elegant OpenCode\n\n## Paired subtitle\n\n### Paired detail\n\nNATIVE_BODY_SENTINEL stays ordinary selectable terminal text.\n\n## Smaller section\n\n**Bold**, *italic*, `inline code`, and [links](https://example.com).\n\n### A third heading\n\n```python\nprint('native code block')\n```\n\n"
    text += '```json\n{"name":"JSON fixture","big":9007199254740993,"nested":{"ready":true,"items":[1,2]}}\n```\n\n```json\n{"unfinished":\n```\n\n'
    text += "\n\n".join(f"## Section {i}\n\n" + f"Native paragraph {i}. " * 16 for i in range(24))
    text += "\n\n> QUOTED_TEXT stays selectable.\n>\n> **Bold** and `inline code`.\n>\n> - Native list item\n>\n> > Nested quoted text.\n"
    session = api("post", "/api/experimental/session/import", {
        "info": info, "location": {"directory": str(ROOT)},
        "messages": [
            {"id": "msg_mduser_" + seed, "type": "user", "time": {"created": 1}, "text": "Show the md plugin."},
            {"id": "msg_mdassistant_" + seed, "type": "assistant", "time": {"created": 2, "completed": 3},
             "agent": "general", "model": {"providerID": "openai", "id": "gpt-6-astra"},
             "content": [{"type": "text", "text": text}]},
        ],
    })
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 120, 1920, 1440))
    env = dict(os.environ, TERM="xterm-ghostty", COLORTERM="truecolor", TERM_PROGRAM="ghostty",
               OPENCODE_CLI_CONFIG_CONTENT=json.dumps({
                   "plugins": [{"package": str(ROOT), "options": {"diagnostics": str(DIAG)}},
                               {"package": str(ROOT / "test/driver"), "options": {
                                   "ready": str(READY), "otherSession": seed, "fixtureSession": session["id"]}}],
                     "highlights": False, "theme": {"mode": MODE},
                     "terminal": {"copy": "manual"},
                   "keybinds": {"app.exit": "ctrl+alt+q"},
                   "attention": {"notifications": False, "sound": False},
               }))
    for key in list(env):
        if key.startswith(("HERDR_", "CMUX_")):
            env.pop(key)
    child = subprocess.Popen(["opencode", "--session", session["id"], str(ROOT)],
                             stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)
    pending = b""
    columns = 120
    lines = 45
    def pump():
        global pending
        if not select.select([master], [], [], .02)[0]:
            return
        try:
            chunk = os.read(master, 1024 * 1024)
        except OSError:
            return
        output.extend(chunk)
        pending += chunk
        replies = [(b"\x1b[6n", b"\x1b[1;1R"), (b"\x1b[c", b"\x1b[?62;4;22c"),
                   (b"\x1b[>c", b"\x1b[>1;4000;0c"), (b"\x1b[?u", b"\x1b[?0u"),
                   (b"\x1b[14t", f"\x1b[4;{lines * 32};{columns * 16}t".encode()), (b"\x1b[16t", b"\x1b[6;32;16t"),
                   (b"\x1b[18t", f"\x1b[8;{lines};{columns}t".encode()), (b"\x1b[>q", b"\x1bP>|ghostty 1.3.0\x1b\\")]
        for query, reply in replies:
            if query in pending:
                os.write(master, reply)
                pending = pending.replace(query, b"")
        for match in list(re.finditer(rb"\x1b_G([^;]*);([^\x1b]*)\x1b\\", pending)):
            metadata = match.group(1)
            if b"a=q" in metadata:
                ident = re.search(rb"(?:^|,)i=(\d+)", metadata)
                if ident:
                    os.write(master, b"\x1b_Gi=" + ident.group(1) + b";OK\x1b\\")
            pending = pending.replace(match.group(0), b"")
        for match in list(re.finditer(rb"\x1b\](10|11);\?(?:\x07|\x1b\\)", pending)):
            rgb = b"ffff/ffff/ffff" if match.group(1) == b"11" else b"2222/2222/2222"
            os.write(master, b"\x1b]" + match.group(1) + b";rgb:" + rgb + b"\x1b\\")
            pending = pending.replace(match.group(0), b"")
        pending = pending[-8192:]
    def diag():
        try:
            return json.loads(DIAG.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
    def wait(predicate, label, seconds=20):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            pump()
            if predicate():
                return
            if child.poll() is not None:
                break
        raise AssertionError(f"{label}: {diag()}")
    def settle(seconds=.5):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            pump()
    wait(lambda: DIAG.exists(), "plugin load")
    wait(lambda: READY.exists(), "streaming fixture plugin registration")
    settle(2)
    assert diag()["plugin"] == "md" and diag()["enabled"], diag()
    assert diag()["headings"] > 0 and diag()["quotes"], "md should enable every style together"
    assert all(quote["border"] == ["left"] and quote["height"] >= 3 for quote in diag()["quotes"])
    os.write(master, b"/md off\r")
    wait(lambda: diag()["enabled"] is False and diag()["attached"] == 0, "Disable md styling")
    settle()
    assert not diag()["quotes"] and diag()["headings"] == 0, diag()
    codes = json.loads(Path(str(READY) + ".json").read_text())
    assert codes[0]["content"] == '{"name":"JSON fixture","big":9007199254740993,"nested":{"ready":true,"items":[1,2]}}', codes
    os.write(master, b"/md \r")
    wait(lambda: diag()["enabled"] and bool(diag()["quotes"]), "Toggle md styling back on")
    wait(lambda: diag().get("headings", 0) > 0 and diag().get("raster", {}).get("renders", 0) > 0, "heading rendering")
    settle(1)
    assert not diag()["failure"], diag()
    assert b"\x1b_G" in output, "No graphics output"
    assert b"Native paragraph" in output, "Body text was not emitted natively"
    initial = diag()
    # Toast expiry can legitimately redraw. Once it has expired, cached
    # headings must not keep requesting frames through native layout setters.
    settle(4)
    idle_before = diag()["scans"]
    idle_bytes = len(output)
    settle(.75)
    idle_after = diag()["scans"]
    idle_output = len(output) - idle_bytes
    assert idle_after == idle_before, ("Idle Markdown kept redrawing", idle_before, idle_after)
    assert idle_output == 0, "Idle Markdown emitted terminal output"
    assert initial["headingColor"] == HEADING, initial
    configured_fonts = re.findall(r"^font-family = (.+)$",
                                 subprocess.check_output(["ghostty", "+show-config"], text=True, timeout=5), re.M)
    assert configured_fonts and initial["fontFamilies"] == configured_fonts, initial
    assert all(configured_fonts[0] in node["image"]["font"] for node in initial["nodes"] if node.get("image"))
    def spacing():
        try:
            return json.loads(Path(str(READY) + ".spacing.json").read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return []
    def grouped(count):
        values = spacing()
        return (sum(gap["stacked"] for gap in values) == count
                and all(gap["following"] == 0 for gap in values)
                and all(gap["top"] == 0 and gap["inset"] == 0 if gap["stacked"]
                        else gap["top"] == 0 and gap["inset"] > 0 for gap in values))
    assert grouped(2), spacing()
    os.write(master, b"/md-test separate\r")
    wait(lambda: grouped(1), "paragraph insertion must restore normal heading spacing")
    os.write(master, b"/md-test join\r")
    wait(lambda: grouped(2), "paragraph removal must collapse consecutive heading spacing again")
    settle()
    initial = diag()
    codes = json.loads(Path(str(READY) + ".json").read_text())
    assert len(codes) == 2, codes
    assert codes[0]["content"] == '{\n  "name": "JSON fixture",\n  "big": 9007199254740993,\n  "nested": {\n    "ready": true,\n    "items": [\n      1,\n      2\n    ]\n  }\n}', codes
    assert codes[0]["height"] >= 10 and not codes[0]["destroyed"], codes
    assert codes[1]["content"] == '{"unfinished":', codes
    # Keep both drag endpoints away from the viewport's selection-autoscroll
    # zone; tighter heading spacing can put the first visible image on its edge.
    image = next(node["image"] for node in initial["nodes"] if node.get("image") and 10 <= node["image"]["y"] < 24)
    x, y = int(image["x"]) + 1, int(image["y"]) + 1
    os.write(master, f"\x1b[<0;{x};{y}M".encode())
    settle(.1)
    os.write(master, f"\x1b[<32;{x + image['width']};{y + image['height'] - 1}M".encode())
    settle(.1)
    os.write(master, f"\x1b[<0;{x + image['width']};{y + image['height'] - 1}m".encode())
    settle(.2)
    assert diag()["selection"] == image["text"], f"Heading drag selection: {diag()['selection']!r}, expected {image['text']!r}"
    os.write(master, b"\x1b")
    settle(.2)
    # Drag from the image into the real native paragraph, then repeat backwards.
    # Both must contribute to the same OpenCode Selection object.
    def drag(start, end):
        os.write(master, f"\x1b[<0;{start[0]};{start[1]}M".encode())
        settle(.05)
        for i in range(1, 5):
            xx = round(start[0] + (end[0] - start[0]) * i / 4)
            yy = round(start[1] + (end[1] - start[1]) * i / 4)
            os.write(master, f"\x1b[<32;{xx};{yy}M".encode())
            settle(.05)
        os.write(master, f"\x1b[<0;{end[0]};{end[1]}m".encode())
        settle(.2)
        return diag()["selection"]
    selection = drag((x, y), (x + 35, y + image["height"] + 3))
    assert selection.startswith(image["text"]), selection
    assert "Native paragraph" in selection, selection
    os.write(master, b"\x1b")
    settle(.2)
    reverse = drag((x + 35, y + image["height"] + 3), (x, y))
    assert reverse == selection, (selection, reverse)
    os.write(master, b"\x1b")
    settle(.2)
    quoted = json.loads(Path(str(READY) + ".quotes.json").read_text())
    quote = next(node for node in quoted if "QUOTED_TEXT" in node["content"] and 0 <= node["y"] < 35)
    qx, qy = int(quote["x"]) + 1, int(quote["y"]) + 1
    chosen = drag((qx, qy), (qx + len("QUOTED_TEXT stays selectable.") + 1, qy))
    assert chosen.startswith("QUOTED_TEXT stays selectable."), chosen
    os.write(master, b"\x1b")
    settle(.2)
    transmissions = len(re.findall(rb"\x1b_G[^;]*a=[Tt]", output))
    for i in range(30):
        os.write(master, b"\x1b[<64;50;20M")
        settle(.03)
    settle()
    after = diag()
    assert after["raster"]["renders"] == initial["raster"]["renders"], "Scroll rerasterized headings"
    assert after["typography"] == initial["typography"], "Scrolling rebuilt native typography styles"
    # Narrowing changes line wrapping and heading raster keys.
    columns = 80
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 80, 1280, 1440))
    os.kill(child.pid, signal.SIGWINCH)
    settle(1)
    assert not diag()["failure"], diag()
    assert max(node["width"] for node in diag()["nodes"]) < initial["nodes"][0]["width"], "Resize did not change layout"
    os.write(master, b"/md off\r")
    wait(lambda: not diag()["enabled"] and diag()["headings"] == 0, "Disable md with large headings")
    assert not diag()["quotes"] and diag()["attached"] == 0, diag()
    os.write(master, b"/md on\r")
    wait(lambda: diag()["enabled"] and diag()["headings"] > 0, "Restore md and its large headings")
    os.write(master, b"/md-test run\r")
    wait(lambda: diag().get("headings", 0) == 30, "streaming heading")
    settle(1)
    assert not diag()["failure"], diag()
    codes = json.loads(Path(str(READY) + ".json").read_text())
    assert any(code["content"] == '{\n  "streamed": true,\n  "number": 9007199254740993\n}' for code in codes), codes
    quoted = json.loads(Path(str(READY) + ".quotes.json").read_text())
    assert any("STREAM_QUOTE stays native." in quote["content"] for quote in quoted), quoted
    # The body must still be terminal characters after streaming updates.
    os.write(master, b"\x1b[1;5F")
    settle()
    os.write(master, b"/md off\r")
    wait(lambda: not diag()["enabled"], "Disable before native terminal fallback")
    os.write(master, b"/md-test native\r")
    settle()
    os.write(master, b"/md on\r")
    wait(lambda: diag()["enabled"] and not diag()["supported"] and diag()["headings"] == 0 and bool(diag()["quotes"]),
         "Native terminal fallback retains Markdown styling")
    os.write(master, b"/md-test lists\r")
    def listing():
        return json.loads(Path(str(READY) + ".lists.json").read_text())
    def list_spacing():
        return json.loads(Path(str(READY) + ".list-spacing.json").read_text())
    wait(lambda: any("BULLET_FIRST" in item["body"][0]["content"] for item in listing() if item["body"]), "Native list fixture")
    settle()
    items = listing()
    def item(prefix):
        return next(item for item in items if item["body"] and item["body"][0]["content"].startswith(prefix))
    assert item("BULLET_FIRST")["marker"].strip() == "•", items
    assert item("NESTED_BULLET")["marker"].strip() == "◦", items
    assert item("NUMBER_NINE")["marker"].strip() == "9.", items
    assert item("NUMBER_TEN")["marker"].strip() == "10.", items
    assert item("NESTED_NUMBER")["marker"].strip() == "1.", items
    assert item("TASK_OPEN")["marker"].strip() == "• ☐", items
    assert item("TASK_DONE")["marker"].strip() == "• ☑", items
    assert item("NUMBER_NINE")["textX"] == item("NUMBER_TEN")["textX"] == item("NUMBER_ELEVEN")["textX"], items
    assert item("BULLET_FIRST")["x"] == item("BULLET_FIRST")["listX"] + 2, items
    assert item("WRAPPED_BULLET")["body"][0]["height"] > 1, items
    assert item("NUMBER_TEN")["body"][0]["height"] > 1, items
    assert all(item["textX"] == item["x"] + item["width"] + 1 for item in items), items
    assert [(gap.get("before"), gap.get("after")) for gap in list_spacing()] == [(1, 1), (1, 1)], list_spacing()
    wrapped = item("WRAPPED_BULLET")["body"][0]
    assert wrapped["x"] == item("WRAPPED_BULLET")["textX"], wrapped
    start = item("BULLET_FIRST")["body"][0]
    selected = drag((int(start["x"]) + 1, int(start["y"]) + 1),
                    (int(start["x"]) + 15, int(start["y"]) + 1))
    assert selected.startswith("BULLET_FIRST"), selected
    os.write(master, b"\x1b")
    settle()
    start = item("NUMBER_NINE")["body"][0]
    selected = drag((int(start["x"]) + 1, int(start["y"]) + 1),
                    (int(start["x"]) + 15, int(start["y"]) + 1))
    assert selected.startswith("NUMBER_NINE"), selected
    os.write(master, b"\x1b")
    settle()
    old_height = item("NUMBER_TEN")["body"][0]["height"]
    columns = 64
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 45, columns, columns * 16, 1440))
    os.kill(child.pid, signal.SIGWINCH)
    wait(lambda: next(entry["body"][0]["height"] for entry in listing()
                     if entry["body"] and entry["body"][0]["content"].startswith("NUMBER_TEN")) > old_height,
         "Numbered text should rewrap natively on resize")
    settle()
    items = listing()
    assert item("NUMBER_NINE")["textX"] == item("NUMBER_TEN")["textX"] == item("NUMBER_ELEVEN")["textX"], items
    assert all(entry["textX"] == entry["x"] + entry["width"] + 1 for entry in items), items
    decoration = diag()["lists"].copy()
    rasters = diag()["raster"]["renders"]
    for i in range(10):
        os.write(master, b"\x1b[<64;50;20M")
        settle(.03)
    settle()
    assert diag()["lists"] == decoration, "Scrolling reapplied list decoration"
    assert diag()["raster"]["renders"] == rasters, "Lists caused image rasterization"
    os.write(master, b"/md-test list-append\r")
    wait(lambda: any(entry["body"] and entry["body"][0]["content"].startswith("STREAMED_TEN") for entry in listing()), "Streamed list items")
    settle()
    items = listing()
    assert item("STREAMED_BULLET")["marker"].strip() == item("STREAMED_SECOND")["marker"].strip() == "•", items
    assert item("BULLET_FIRST")["marker"].strip() == "•" and item("NESTED_BULLET")["marker"].strip() == "◦", items
    assert item("TASK_OPEN")["marker"].strip() == "• ☐" and item("TASK_DONE")["marker"].strip() == "• ☑", items
    assert item("STREAMED_NINE")["marker"].strip() == "9." and item("STREAMED_TEN")["marker"].strip() == "10.", items
    assert item("STREAMED_NINE")["textX"] == item("STREAMED_TEN")["textX"], items
    assert all(entry["textX"] == entry["x"] + entry["width"] + 1 for entry in items), items
    assert [(gap.get("before"), gap.get("after")) for gap in list_spacing()] == [(1, 1), (1, 1), (1, 1), (1, None)], list_spacing()
    os.write(master, b"/md-test task-toggle\r")
    wait(lambda: any(entry["marker"].strip() == "• ☑" and entry["body"]
                     and entry["body"][0]["content"].startswith("TASK_OPEN") for entry in listing()), "Checkbox state update")
    os.write(master, b"/md-test source\r")
    wait(lambda: any(entry["marker"].strip() == "-" for entry in listing()), "Source mode restores native markers")
    assert all(gap.get("before", 1) >= 1 for gap in list_spacing()), list_spacing()
    os.write(master, b"/md-test conceal\r")
    wait(lambda: bool(listing()) and all("-" not in entry["marker"] for entry in listing()), "Concealed list styling returns")
    items = listing()
    assert item("BULLET_FIRST")["marker"].strip() == "•" and item("NESTED_BULLET")["marker"].strip() == "◦", items
    assert item("TASK_OPEN")["marker"].strip() == "• ☑", items
    assert [(gap.get("before"), gap.get("after")) for gap in list_spacing()] == [(1, 1), (1, 1), (1, 1), (1, None)], list_spacing()
    os.write(master, b"/md off\r")
    wait(lambda: not diag()["enabled"] and any(entry["marker"].strip() == "-" for entry in listing()),
         "Disable md restores native list markers")
    settle()
    items = listing()
    assert item("BULLET_FIRST")["x"] == item("BULLET_FIRST")["listX"], items
    assert diag()["attached"] == 0, diag()
    os.write(master, b"/md on\r")
    wait(lambda: diag()["enabled"] and bool(listing()) and all("-" not in entry["marker"] for entry in listing()),
         "Enable md restores decorated lists")
    settle()
    items = listing()
    assert item("BULLET_FIRST")["x"] == item("BULLET_FIRST")["listX"] + 2, items
    assert diag()["raster"]["renders"] == rasters, "List updates caused image rasterization"
    os.write(master, b"/md-test inline\r")
    def inline():
        return json.loads(Path(str(READY) + ".inline.json").read_text())
    def inline_ready(word):
        return any(word in chunk["text"] for node in inline()["nodes"] for chunk in node["chunks"])
    wait(lambda: inline_ready("QUOTE_CODE"), "Native inline styling")
    settle()
    def check_inline(prefix, bold, italic, code, link=None):
        data = inline()
        node = next(node for node in data["nodes"] if node["content"].startswith(prefix))
        def chunk(word):
            return next(chunk for chunk in node["chunks"] if word in chunk["text"])
        assert chunk(bold)["fg"] == data["palette"]["text"] and chunk(bold)["attributes"] & 1, node
        assert chunk(italic)["fg"] == data["palette"]["text"] and chunk(italic)["attributes"] & 4, node
        assert chunk(code)["fg"] == INLINE_CODE, node
        assert chunk(code)["bg"] == data["palette"]["codeBackground"], node
        assert chunk(prefix).get("bg") != data["palette"]["codeBackground"], node
        if link:
            assert chunk(link)["fg"] == data["palette"]["link"], node
            assert re.search(rb"\x1b\]8;[^\x1b\x07]*;https://example\.com", output), "Native hyperlink missing"
        return node
    styled = check_inline("INLINE_STYLE_SENTINEL", "BOLD_WORD", "ITALIC_WORD", "CODE_WORD", "LINK_WORD")
    check_inline("INLINE_LIST", "LIST_BOLD", "LIST_ITALIC", "LIST_CODE")
    check_inline("INLINE_QUOTE", "QUOTE_BOLD", "QUOTE_ITALIC", "QUOTE_CODE")
    start = styled["plainText"].index("BOLD_WORD")
    selected = drag((int(styled["x"]) + start + 1, int(styled["y"]) + 1),
                    (int(styled["x"]) + start + len("BOLD_WORD"), int(styled["y"]) + 1))
    assert selected == "BOLD_WORD", selected
    os.write(master, b"\x1b")
    settle()
    typography = diag()["typography"].copy()
    os.write(master, b"/md-test inline-append\r")
    wait(lambda: inline_ready("STREAM_CODE"), "Streamed inline styling")
    settle()
    check_inline("INLINE_STREAM", "STREAM_BOLD", "STREAM_ITALIC", "STREAM_CODE", "STREAM_LINK")
    assert diag()["typography"] == typography, "Streaming rebuilt native typography styles"
    assert diag()["raster"]["renders"] == rasters, "Inline styling rasterized images"
    lines = 70
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", lines, columns, columns * 16, lines * 32))
    os.kill(child.pid, signal.SIGWINCH)
    settle()
    os.write(master, b"/md-test tables\r")
    def table_data():
        return json.loads(Path(str(READY) + ".tables.json").read_text())
    def header_height():
        tables = table_data()["tables"]
        return tables[0]["rowHeights"][0] if tables and tables[0]["rowHeights"] else 0
    def painted_cells(line):
        return [{**span, "char": char} for span in line for char in span["text"]]
    def header_lines(table, column):
        left = table["x"] + table["columnOffsets"][column] + 1
        width = table["columnWidths"][column]
        top = table["rowOffsets"][0] + 2
        return ["".join(cell["char"] for cell in painted_cells(line)[left:left + width]).strip()
                for line in table["painted"][top:top + table["rowHeights"][0] - 2]]
    wait(lambda: bool(table_data()["tables"]), "Native table fixture")
    settle()
    def check_table(row_count):
        data = table_data()
        table = data["tables"][0]
        assert len(table["rows"]) == row_count, table
        assert table["borders"], "Table styling removed the outer/inner grid"
        assert table["padding"] == 2, "Body cells need two spaces on each side"
        assert table["paddingY"] == 0, "Compact table cells should not add blank padding rows"
        assert table["rowHeights"][0] >= 3, "Header needs one filled row above and below its labels"
        assert all(height == 1 for row, height in enumerate(table["rowHeights"]) if row not in (0, 3)), table
        assert table["y"] >= 0 and len(table["painted"]) == table["height"], "Fixture must be fully visible"
        heading = next(span for line in data["nativeHeadings"] for span in line if "TABLE_HEADING" in span["text"])
        assert heading["fg"] == HEADING and heading["attributes"] & 1, heading
        for index in range(row_count):
            color = TABLE_HEADER if index == 0 else TABLE_WHITE
            top = table["rowOffsets"][index] + 1
            for line in table["painted"][top:top + table["rowHeights"][index]]:
                cells = painted_cells(line)
                for column, width in enumerate(table["columnWidths"]):
                    left = table["x"] + table["columnOffsets"][column] + 1
                    padding = 3 if index == 0 else 2
                    assert all(cell["char"] == " " for cell in cells[left:left + padding]), (index, column, line)
                    assert all(cell["char"] == " " for cell in cells[left + width - padding:left + width]), (index, column, line)
                    for cell in cells[left:left + width]:
                        assert cell["bg"] == color or (cell["fg"] == INLINE_CODE and cell["bg"] == TABLE_CODE_BG), (index, column, cell)
                for offset in table["columnOffsets"]:
                    border = cells[table["x"] + offset]
                    assert border["char"] == "│" and border["bg"] == data["background"], border
                    assert border["fg"] == table["borderColor"], border
            if index == 0:
                for offset in [top, top + table["rowHeights"][0] - 1]:
                    cells = painted_cells(table["painted"][offset])
                    for column, width in enumerate(table["columnWidths"]):
                        left = table["x"] + table["columnOffsets"][column] + 1
                        assert all(cell["char"] == " " for cell in cells[left:left + width]), (offset, cells)
                for column, label in enumerate(table["rows"][0]):
                    assert "".join("".join(header_lines(table, column)).split()) == "".join(label.split()), table
                for line in table["painted"][top + 1:top + table["rowHeights"][0] - 1]:
                    cells = painted_cells(line)
                    for column, width in enumerate(table["columnWidths"]):
                        left = table["x"] + table["columnOffsets"][column] + 1
                        assert all(cell["fg"] == HEADING and cell["attributes"] & 1
                                   for cell in cells[left:left + width] if cell["char"] != " "), line
        for offset in table["rowOffsets"]:
            cells = painted_cells(table["painted"][offset])[table["x"]:table["x"] + table["width"]]
            assert all(cell["char"] in "─┌┬┐├┼┤└┴┘" and cell["bg"] == data["background"] for cell in cells), cells
        for word in ["WHITE_CODE", "TABLE_CODE"]:
            code = next(span for line in table["painted"] for span in line if word in span["text"])
            assert code["fg"] == INLINE_CODE and code["bg"] == TABLE_CODE_BG, code
        left = table["x"] + table["columnOffsets"][0] + 1
        header = painted_cells(table["painted"][table["rowOffsets"][0] + 2])
        body = painted_cells(table["painted"][table["rowOffsets"][1] + 1])
        assert header[left + 3]["char"] == "N" and body[left + 2]["char"] == "R", (header, body)
        return table
    table = check_table(5)
    assert table["rowHeights"][3] > 1, table
    assert any("TABLE_CODE" in span["text"] and span["fg"] == INLINE_CODE for line in table["painted"] for span in line), table
    tx = table["x"] + table["columnOffsets"][0] + 1 + table["padding"] + 1
    hx = tx + 1
    hy = table["y"] + table["rowOffsets"][0] + 3
    selected = drag((hx, hy), (hx + len("Name"), hy))
    assert selected == "Name", selected
    os.write(master, b"\x1b")
    settle()
    ty = table["y"] + table["rowOffsets"][1] + table["paddingY"] + 2
    selected = drag((tx, ty), (tx + len("ROW_ONE"), ty))
    assert selected.strip() == "ROW_ONE", selected
    os.write(master, b"\x1b")
    settle()
    selected = drag((hx, hy), (tx + len("ROW_ONE"), ty))
    assert selected.splitlines() == ["Name", "ROW_ONE"], selected
    os.write(master, b"\x1b")
    settle()
    selected = drag((hx + 3, hy), (hx + 1, hy))
    assert selected == "ame", selected
    os.write(master, b"\x1b")
    settle()
    check_table(5)
    table_work = diag()["tables"].copy()
    old_width = table["width"]
    old_height = table["rowHeights"][3]
    columns = 80
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", lines, columns, columns * 16, lines * 32))
    os.kill(child.pid, signal.SIGWINCH)
    wait(lambda: table_data()["tables"][0]["width"] > old_width, "Native table resize")
    settle()
    table = check_table(5)
    assert table["rowHeights"][3] < old_height, table
    assert diag()["tables"] == table_work, "Resize restyled table cells"
    for i in range(10):
        os.write(master, b"\x1b[<64;50;20M")
        settle(.03)
    settle()
    assert diag()["tables"] == table_work, "Scrolling restyled table cells"
    os.write(master, b"/md-test table-append\r")
    wait(lambda: any(len(table["rows"]) == 7 for table in table_data()["tables"]), "Streamed table rows")
    settle()
    check_table(7)
    os.write(master, b"/md off\r")
    wait(lambda: not diag()["enabled"] and header_height() == 1,
         "Disable md restores compact native headers")
    os.write(master, b"/md on\r")
    wait(lambda: diag()["enabled"] and header_height() >= 3,
         "Enable md restores padded headers")
    settle()
    check_table(7)
    os.write(master, b"/md-test table-header\r")
    wait(lambda: "HEADER_END" in table_data()["tables"][0]["rows"][0][1], "Wrapped table header")
    settle()
    table = check_table(7)
    assert table["rowHeights"][0] > 3, table
    wrapped = header_lines(table, 1)
    assert wrapped[-1].endswith("HEADER_END"), wrapped
    tx = table["x"] + table["columnOffsets"][1] + table["padding"] + 3
    hy = table["y"] + table["rowOffsets"][0] + 3
    selected = drag((tx, hy), (tx + len(wrapped[-1]), hy + len(wrapped) - 1))
    assert selected == table["rows"][0][1], selected
    os.write(master, b"\x1b")
    settle()
    check_table(7)
    assert diag()["raster"]["renders"] == rasters, "Tables created image rasters"
    os.write(master, b"/md-test fences\r")
    def fence_data():
        return json.loads(Path(str(READY) + ".fences.json").read_text())
    wait(lambda: len(fence_data()["fences"]) == 6, "Fenced code fixtures")
    settle()
    def check_fences(count):
        data = fence_data()
        assert len(data["fences"]) == count, data
        for fence in data["fences"]:
            box = fence["box"]
            assert box["marginTop"] == 1, fence
            above = painted_cells(fence["above"])[box["x"]:box["x"] + box["width"]]
            assert len(above) == box["width"] and all(cell["char"] == " " for cell in above), fence
            assert box["background"] == fence["background"] == data["background"], fence
            assert fence["x"] - box["x"] == 2, fence
            assert fence["y"] - box["y"] == 2, fence
            assert box["height"] == fence["height"] + 3, fence
            assert fence["width"] == box["width"] - 4, fence
            assert box["labels"] == [(fence.get("filetype") or "text").lower()], box["labels"]
            assert fence["plainText"] == fence["content"], fence
            assert box["y"] >= 0 and len(fence["painted"]) == box["height"], "Fences must be fully visible"
            assert data["titleBackground"] != data["background"], data
            for index, line in enumerate(fence["painted"]):
                background = data["titleBackground"] if index == 0 else data["background"]
                cells = painted_cells(line)[box["x"]:box["x"] + box["width"]]
                assert len(cells) == box["width"] and all(cell["bg"] == background for cell in cells), (fence.get("filetype"), line)
                if index > 0:
                    assert all(cell["char"] == " " for cell in cells[:2] + cells[-2:]), line
        return data["fences"]
    fences = check_fences(6)
    plain = next(fence for fence in fences if "FENCE_TEXT" in fence["content"])
    assert plain["content"] == "FENCE_TEXT\n  **keep literal** and `backticks`", plain
    bare = next(fence for fence in fences if "FENCE_BARE" in fence["content"])
    assert bare["content"] == "FENCE_BARE\n  exact spaces", bare
    jsonc = next(fence for fence in fences if "FENCE_JSONC" in fence["content"])
    assert jsonc["content"] == '{ // FENCE_JSONC\n  "ready": true\n}', jsonc
    javascript = next(fence for fence in fences if "FENCE_JS" in fence["content"])
    code_colors = {span["fg"] for span in javascript["painted"][2]
                   if span["text"].strip() and span["bg"] == fence_data()["background"]}
    assert len(code_colors) > 1, "Code fences lost native syntax highlighting"
    selected = drag((plain["x"] + 1, plain["y"] + 1), (plain["x"] + len("FENCE_TEXT"), plain["y"] + 1))
    assert selected == "FENCE_TEXT", selected
    os.write(master, b"\x1b")
    settle()
    panels = [fence["box"]["id"] for fence in check_fences(6)]
    for i in range(10):
        os.write(master, b"\x1b[<64;50;20M")
        settle(.03)
    settle()
    assert [fence["box"]["id"] for fence in check_fences(6)] == panels, "Scrolling rebuilt code panels"
    os.write(master, b"/md-test fence-append\r")
    wait(lambda: len(fence_data()["fences"]) == 7, "Open streamed text fence")
    settle()
    assert check_fences(7)[-1]["content"].rstrip("\n") == "FENCE_STREAM"
    open_fence = check_fences(7)[-1]
    stream_panels = [fence["box"]["id"] for fence in check_fences(7)[:6]]
    reuse_before = diag()["fences"]["reused"]
    os.write(master, b"/md-test fence-chunk\r")
    wait(lambda: "stream stays literal" in fence_data()["fences"][-1]["content"], "Updated streamed text fence")
    settle()
    assert check_fences(7)[-1]["content"].rstrip("\n") == "FENCE_STREAM\n  **stream stays literal**"
    closed_fence = check_fences(7)[-1]
    assert open_fence["box"]["id"] == closed_fence["box"]["id"], "Streaming replaced the active code panel"
    assert open_fence["instance"] == closed_fence["instance"], "Streaming replaced the native code buffer"
    assert diag()["fences"]["reused"] > reuse_before, "Native fence reuse adapter was not exercised"
    fence_history = fence_data()["history"]
    assert all(frame["panel"] == open_fence["box"]["id"] and frame["instance"] == open_fence["instance"]
               and frame["insetX"] == frame["insetY"] == 2
               and frame["panelHeight"] == frame["height"] + 3 for frame in fence_history), fence_history
    assert [fence["box"]["id"] for fence in check_fences(7)[:6]] == stream_panels, "Streaming rebuilt unchanged panels"
    os.write(master, b"/md-test fence-close\r")
    wait(lambda: fence_data()["fences"][-1]["content"] == "FENCE_STREAM\n  **stream stays literal**",
         "Completed streamed text fence")
    settle()
    check_fences(7)
    for command in ["source", "conceal"]:
        os.write(master, f"/md-test {command}\r".encode())
        settle()
        if command == "source":
            assert all("background" not in fence["box"] for fence in fence_data()["fences"]), fence_data()
        else:
            check_fences(7)
    os.write(master, b"/md off\r")
    wait(lambda: not diag()["enabled"], "Disable fenced code styling")
    settle()
    assert all("background" not in fence["box"] for fence in fence_data()["fences"]), fence_data()
    os.write(master, b"/md on\r")
    wait(lambda: diag()["enabled"], "Restore fenced code styling")
    settle()
    check_fences(7)
    for language in ["text", "txt", "plaintext", ""]:
        os.write(master, f"/md-test fence-only {language}\r".encode())
        wait(lambda: len(fence_data()["fences"]) == 1 and "FENCE_ONLY" in fence_data()["fences"][0]["content"],
             "Code-only Markdown")
        settle()
        assert check_fences(1)[0]["content"] == "NATIVE_BODY_SENTINEL FENCE_ONLY\n  **still literal**"
    # A registered renderer can choose native code or its own widget based on
    # the latest text. Reuse must still invoke it once for every changed token.
    def foreign():
        return json.loads(Path(str(READY) + ".foreign.json").read_text())
    os.write(master, b"/md-test foreign-start\r")
    wait(lambda: any("FENCE_FOREIGN_DEFAULT" in fence["content"] for fence in fence_data()["fences"]),
         "Default-delegating third-party renderer")
    settle()
    calls = foreign()["calls"]
    os.write(master, b"/md-test foreign-widget\r")
    wait(lambda: foreign()["live"] and "FENCE_FOREIGN_WIDGET" in foreign()["content"], "Third-party replacement")
    settle()
    assert foreign()["calls"] == calls + 1, foreign()
    assert not fence_data()["fences"], "Third-party widget was wrapped as native code"
    os.write(master, b"/md-test foreign-default\r")
    wait(lambda: bool(fence_data()["fences"]), "Third-party renderer returns to default code")
    settle()
    assert foreign()["calls"] == calls + 2 and not foreign()["live"], foreign()
    default_fence = check_fences(1)[0]
    os.write(master, b"/md-test foreign-update\r")
    wait(lambda: "UPDATED" in fence_data()["fences"][0]["content"], "Default-delegating renderer gets fresh defaults")
    settle()
    updated_fence = check_fences(1)[0]
    assert foreign()["calls"] == calls + 3, foreign()
    assert default_fence["instance"] != updated_fence["instance"]
    assert default_fence["wrapMode"] == "none" and updated_fence["wrapMode"] != "none"
    os.write(master, b"/md-test fence-js\r")
    wait(lambda: any("FENCE_JS_STREAM" in fence["content"] for fence in fence_data()["fences"]), "Streaming JavaScript fence")
    settle()
    js_before = check_fences(1)[0]
    os.write(master, b"/md-test fence-js-update\r")
    wait(lambda: "streamed syntax" in fence_data()["fences"][0]["content"], "Updated JavaScript fence")
    settle()
    js_after = check_fences(1)[0]
    assert js_before["instance"] == js_after["instance"], "Unregistered-language native buffer was replaced"
    assert js_before["box"]["id"] == js_after["box"]["id"]
    os.write(master, b"/md-test visibility\r")
    def visibility():
        try:
            return json.loads(Path(str(READY) + ".visibility.json").read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
    wait(lambda: bool(visibility()) and (not visibility()["enabled"] or visibility()["results"][-1]["phase"] == "restored"),
         "Owned-client session-tab visibility probe")
    assert any("NATIVE_BODY_SENTINEL" in node["content"] for node in visibility()["results"][-1]["markdown"]), visibility()
    assert diag()["raster"]["renders"] == rasters, "Code fences created image rasters"
    result = {"version": subprocess.check_output(["opencode", "--version"], text=True).strip(),
              "idle": {"before": idle_before, "after": idle_after, "terminalBytes": idle_output},
              "initial": initial, "afterScroll": after, "initialImageTransmissions": transmissions,
              "selection": selection,
               "lists": diag()["lists"], "listScrollDecoration": decoration,
                 "typography": diag()["typography"],
                  "tables": diag()["tables"],
                  "fences": diag()["fences"], "fenceHistory": fence_history,
                  "thirdParty": foreign(),
                  "visibility": visibility(),
                  "result": "PASS: unified md on/off; heading/native fallback and inline colors; native tables and fenced-code panels, selection and streaming; headings/quotes/JSON/lists regressions; cached scrolling"}
    (ART / "result.json").write_text(json.dumps(result, indent=2))
    print(result["result"])
    print(json.dumps({"raster": initial["raster"], "afterScroll": after["raster"]}, indent=2))
finally:
    (ART / "terminal-output.bin").write_bytes(output)
    if child and child.poll() is None:
        # Only this test's newly spawned client receives the documented app.exit
        # command. Keep fixture sessions and never force process cleanup.
        os.write(master, b"\x1b\x11")  # documented app.exit, isolated binding
        end = time.monotonic() + 15
        while child.poll() is None and time.monotonic() < end:
            pump()
        if child.poll() is None:
            # Retain the PTY master as well: closing its last descriptor can
            # hang up the client. A detached reader keeps it alive for recovery.
            keeper = os.fork()
            if keeper == 0:
                os.setsid()
                while True:
                    try:
                        os.read(master, 1024 * 1024)
                    except OSError:
                        os._exit(0)
            (ART / "preserved-client.json").write_text(json.dumps({
                "pid": child.pid, "session": session["id"], "ptyKeeper": keeper,
            }))
            raise RuntimeError(f"Normal app.exit timed out; preserved client {child.pid}, session {session['id']}, PTY keeper {keeper}")
    if master is not None:
        os.close(master)
    (ART / "retained-sessions.json").write_text(json.dumps({
        "seed": seed, "session": session["id"] if session else None,
        "pid": child.pid if child else None, "exitCode": child.returncode if child else None,
        "sessionsRetained": True, "terminationSignalsSent": False,
    }, indent=2))
