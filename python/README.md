# SilbercueChrome — Python Script API

Python client for SilbercueChrome browser automation. Scripts use the same tool implementations as the MCP server (Shared Core) — every improvement to `click`, `navigate`, `fill_form` etc. automatically benefits your scripts too. One codebase, one test suite (1600+ tests), two access paths.

## Installation

```bash
pip install silbercuechrome
```

That's it. No manual Chrome launch needed — `Chrome.connect()` starts everything automatically.

## Quick Start

```python
from silbercuechrome import Chrome

chrome = Chrome.connect()

with chrome.new_page() as page:
    page.navigate("https://example.com")
    title = page.evaluate("document.title")
    print(title)  # "Example Domain"

chrome.close()
```

`Chrome.connect()` auto-starts the SilbercueChrome server as a subprocess, which in turn launches Chrome. When you call `chrome.close()`, the server subprocess is terminated.

## How it works

```
Python Script                        Escape Hatch (Power User)
    │                                    │
    ▼                                    ▼
HTTP POST /tool/{name}              WebSocket (CDP)
Port 9223                           Port 9222
    │                                    │
    ▼                                    │
SilbercueChrome Server                   │
    │                                    │
    ▼                                    │
registry.executeTool()                   │
    │                                    │
    ▼                                    │
Tool Handler                             │
(click.ts, navigate.ts, ...)             │
    │                                    │
    ▼                                    ▼
Chrome ◄─────────── CDP ────────────────►
```

Your script sends HTTP requests to the SilbercueChrome server on port 9223. The server executes the exact same tool handlers that the MCP server uses — selector resolution, Shadow DOM traversal, scroll-into-view, paint-order filtering, ambient context — all server-side.

## Auto-Start

`Chrome.connect()` finds and starts the server automatically:

1. **Running server** — checks if port 9223 already responds, connects immediately
2. **PATH binary** — finds `silbercuechrome` in PATH (e.g. via Homebrew), starts it with `--script`
3. **npx fallback** — runs `npx -y @silbercue/chrome@latest -- --script`
4. **Explicit path** — `Chrome.connect(server_path="/path/to/silbercuechrome")` for custom setups

## Login and Data Extraction

```python
from silbercuechrome import Chrome

chrome = Chrome.connect()

with chrome.new_page() as page:
    page.navigate("https://app.example.com/login")

    # Fill login form
    page.fill({
        "#email": "user@example.com",
        "#password": "secret",
    })
    page.click("#submit")

    # Wait for dashboard
    page.wait_for("text=Dashboard")

    # Extract data
    data = page.evaluate("""
        Array.from(document.querySelectorAll('.item'))
            .map(el => ({ name: el.textContent, href: el.href }))
    """)
    print(data)

chrome.close()
```

## API Reference

### `Chrome`

| Method | Description |
|---|---|
| `Chrome.connect(host="localhost", port=9223, *, server_path=None, auto_start=True)` | Connect to or auto-start the SilbercueChrome server |
| `chrome.new_page()` | Context manager: open a new tab, auto-closes on exit |
| `chrome.close()` | Close the connection and terminate any auto-started server |

### `Page` (via `chrome.new_page()`)

| Method | Description |
|---|---|
| `page.navigate(url)` | Navigate to URL and wait for load |
| `page.click(selector)` | Click element by CSS selector, text, or ref |
| `page.type(selector, text)` | Type text into input element |
| `page.fill({"sel": "val", ...})` | Fill multiple form fields at once |
| `page.wait_for(condition)` | Wait for JS condition or `"text=..."` shorthand |
| `page.evaluate(expression)` | Run JavaScript, return result |
| `page.download()` | Enable downloads, return download dir |
| `page.close()` | Close the tab (auto-called by context manager) |
| `page.cdp` | Escape Hatch — returns a `CdpEscapeHatch` for direct CDP access (see below) |

### Escape Hatch: `page.cdp.send()`

For use cases the high-level API doesn't cover — network interception, console log subscriptions, performance tracing, cookie management, PDF generation — you can drop down to raw CDP commands via `page.cdp.send()`:

```python
with chrome.new_page() as page:
    page.navigate("https://example.com")

    # Enable network tracking
    page.cdp.send("Network.enable")

    # Get all cookies
    cookies = page.cdp.send("Network.getAllCookies")

    # Performance tracing
    page.cdp.send("Tracing.start", {"categories": "-*,devtools.timeline"})

    # Register event handler
    page.cdp.on("Network.requestWillBeSent", lambda e: print(e["request"]["url"]))
```

The Escape Hatch communicates directly with Chrome via WebSocket (port 9222), bypassing the server entirely. It connects lazily on the first `send()` call and reuses the connection. Each page gets its own WebSocket routed to the correct tab.

| Method | Description |
|---|---|
| `page.cdp.send(method, params=None, *, timeout=30.0)` | Send a CDP command and return the result |
| `page.cdp.on(event, handler)` | Register a callback for a CDP event |
| `page.cdp.close()` | Close the WebSocket (auto-called when the page context manager exits) |

### `CdpClient` (low-level, legacy)

For direct CDP access without the Shared Core server. This is the v1 code path — it works, but does not benefit from server-side improvements. Use `page.cdp.send()` instead for most Escape Hatch use cases.

```python
from silbercuechrome import CdpClient

# Async API
client = await CdpClient.connect(port=9222)
result = await client.send("Runtime.evaluate", {"expression": "1+1"})
await client.close()

# Sync API
client = CdpClient.connect_sync(port=9222)
result = client.send_sync("Runtime.evaluate", {"expression": "1+1"})
client.close_sync()
```

## MCP Coexistence

When the MCP server and Python scripts need to run at the same time, add `--script` to the MCP config. `Chrome.connect()` handles the rest — each script works in its own tab, MCP tabs are never touched.

**Claude Code:**
```bash
claude mcp add --scope user silbercuechrome npx -y @silbercue/chrome@latest -- --script
```

**Cursor / Cline (`mcp.json`):**
```json
{
  "mcpServers": {
    "silbercuechrome": {
      "command": "npx",
      "args": ["-y", "@silbercue/chrome@latest", "--", "--script"]
    }
  }
}
```

## License

MIT
