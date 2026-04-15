"""Page — high-level API for a single browser tab.

A Page wraps a CDP session attached to a specific target (tab).
It exposes ergonomic, synchronous methods that map to CDP commands:

    with chrome.new_page() as page:
        page.navigate("https://example.com")
        page.click("#login")
        page.type("#user", "admin")

All public methods are synchronous. Internally they delegate to the
CdpClient's sync API running on a background event loop.
"""

from __future__ import annotations

import os
import time
import tempfile
from typing import Any

from silbercuechrome.cdp import CdpClient, DEFAULT_TIMEOUT


# Default polling interval for wait_for (seconds)
_POLL_INTERVAL = 0.1
# Default wait_for timeout (seconds)
_WAIT_TIMEOUT = 30.0
# Default download directory
_DOWNLOAD_DIR = os.path.join(tempfile.gettempdir(), "silbercuechrome-downloads")


class Page:
    """High-level API for a single browser tab.

    Do not instantiate directly — use ``chrome.new_page()`` instead.

    Args:
        browser_client: The browser-level CdpClient (for closing the target).
        session_client: A CdpClient connected to this tab's CDP session.
        target_id: The CDP target ID of this tab.
    """

    def __init__(
        self,
        browser_client: CdpClient,
        session_id: str,
        target_id: str,
    ) -> None:
        self._browser = browser_client
        self._session_id = session_id
        self._target_id = target_id
        self._closed = False

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _send(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> dict[str, Any]:
        """Send a CDP command routed to this tab's session."""
        return self._browser.send_sync(
            method, params, timeout=timeout, session_id=self._session_id
        )

    @property
    def target_id(self) -> str:
        """The CDP target ID of this tab."""
        return self._target_id

    @property
    def closed(self) -> bool:
        """Whether this page (tab) has been closed."""
        return self._closed

    # ------------------------------------------------------------------
    # Page methods
    # ------------------------------------------------------------------

    def navigate(self, url: str, *, timeout: float = DEFAULT_TIMEOUT) -> dict[str, Any]:
        """Navigate to a URL and wait for the page to load.

        Args:
            url: The URL to navigate to.
            timeout: Maximum wait time for the load event (seconds).

        Returns:
            Dict with ``frameId`` and ``loaderId`` from Page.navigate.

        Raises:
            RuntimeError: If navigation fails (e.g. net::ERR_NAME_NOT_RESOLVED).
            TimeoutError: If the page does not finish loading in time.
        """
        # Navigate
        result = self._send("Page.navigate", {"url": url}, timeout=timeout)

        # Check for navigation error
        error_text = result.get("errorText")
        if error_text:
            raise RuntimeError(f"Navigation failed: {error_text}")

        # Poll document.readyState until "complete"
        deadline = time.monotonic() + timeout
        while True:
            ready_state = self.evaluate("document.readyState")
            if ready_state == "complete":
                break
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Page did not finish loading within {timeout}s: {url}"
                )
            time.sleep(_POLL_INTERVAL)

        return result

    def click(self, selector: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Click an element identified by CSS selector.

        Uses Runtime.evaluate to find the element and get its bounding box,
        then dispatches mousePressed + mouseReleased via Input domain.

        Args:
            selector: CSS selector for the element to click.
            timeout: Timeout for finding the element.

        Raises:
            RuntimeError: If the element is not found or not visible.
        """
        # Find element and get its center coordinates
        js = f"""
        (() => {{
            const el = document.querySelector({_js_string(selector)});
            if (!el) return {{ error: 'Element not found: {selector}' }};
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0)
                return {{ error: 'Element has zero size: {selector}' }};
            return {{
                x: Math.round(rect.x + rect.width / 2),
                y: Math.round(rect.y + rect.height / 2)
            }};
        }})()
        """
        result = self.evaluate(js, timeout=timeout)
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(result["error"])

        x = result["x"]
        y = result["y"]

        # mousePressed
        self._send(
            "Input.dispatchMouseEvent",
            {
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            },
        )
        # mouseReleased
        self._send(
            "Input.dispatchMouseEvent",
            {
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "clickCount": 1,
            },
        )

    def type(self, selector: str, text: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Type text into an element identified by CSS selector.

        Focuses the element first, then dispatches keyDown + keyUp events
        for each character.

        Args:
            selector: CSS selector for the input element.
            text: The text to type.
            timeout: Timeout for finding the element.

        Raises:
            RuntimeError: If the element is not found.
        """
        # Focus the element
        focus_js = f"""
        (() => {{
            const el = document.querySelector({_js_string(selector)});
            if (!el) return {{ error: 'Element not found: {selector}' }};
            el.focus();
            return {{ ok: true }};
        }})()
        """
        result = self.evaluate(focus_js, timeout=timeout)
        if isinstance(result, dict) and "error" in result:
            raise RuntimeError(result["error"])

        # Type each character
        for char in text:
            self._send(
                "Input.dispatchKeyEvent",
                {"type": "keyDown", "text": char, "key": char},
            )
            self._send(
                "Input.dispatchKeyEvent",
                {"type": "keyUp", "key": char},
            )

    def fill(self, fields: dict[str, str], *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Fill multiple form fields at once.

        Args:
            fields: Mapping of CSS selector to value. Each field is focused,
                cleared, and the value is typed in.
            timeout: Timeout for finding each element.

        Raises:
            RuntimeError: If any element is not found.
        """
        for selector, value in fields.items():
            # Focus and clear the field
            clear_js = f"""
            (() => {{
                const el = document.querySelector({_js_string(selector)});
                if (!el) return {{ error: 'Element not found: {selector}' }};
                el.focus();
                el.value = '';
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                return {{ ok: true }};
            }})()
            """
            result = self.evaluate(clear_js, timeout=timeout)
            if isinstance(result, dict) and "error" in result:
                raise RuntimeError(result["error"])

            # Type the value
            for char in value:
                self._send(
                    "Input.dispatchKeyEvent",
                    {"type": "keyDown", "text": char, "key": char},
                )
                self._send(
                    "Input.dispatchKeyEvent",
                    {"type": "keyUp", "key": char},
                )

    def wait_for(
        self,
        condition: str,
        *,
        timeout: float = _WAIT_TIMEOUT,
        poll_interval: float = _POLL_INTERVAL,
    ) -> Any:
        """Wait for a condition to become truthy.

        Supports a ``text=`` shorthand: ``wait_for("text=Dashboard")`` is
        equivalent to ``wait_for('document.body.innerText.includes("Dashboard")')``.

        Args:
            condition: A JavaScript expression that evaluates to a truthy
                value when the condition is met.  Use ``"text=<string>"`` to
                wait for visible text on the page.
            timeout: Maximum wait time (seconds).
            poll_interval: How often to check the condition (seconds).

        Returns:
            The truthy value of the condition expression.

        Raises:
            TimeoutError: If the condition does not become truthy in time.
        """
        # Shorthand: "text=Dashboard" → document.body.innerText.includes("Dashboard")
        if condition.startswith("text="):
            search_text = condition[5:]
            import json as _json
            condition = f"document.body.innerText.includes({_json.dumps(search_text)})"

        deadline = time.monotonic() + timeout
        while True:
            result = self.evaluate(condition)
            if result:
                return result
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Condition not met within {timeout}s: {condition}"
                )
            time.sleep(poll_interval)

    def evaluate(
        self,
        expression: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        await_promise: bool = False,
    ) -> Any:
        """Evaluate JavaScript in the page context.

        Args:
            expression: JavaScript expression to evaluate.
            timeout: Timeout for the evaluation.
            await_promise: If True, await the result if it is a Promise.

        Returns:
            The evaluated value. Objects are returned by value.
            Returns None for undefined results.

        Raises:
            RuntimeError: If the evaluation throws an exception.
        """
        params: dict[str, Any] = {
            "expression": expression,
            "returnByValue": True,
        }
        if await_promise:
            params["awaitPromise"] = True

        result = self._send("Runtime.evaluate", params, timeout=timeout)

        # Check for exceptions
        if "exceptionDetails" in result:
            exc = result["exceptionDetails"]
            text = exc.get("text", "")
            exception = exc.get("exception", {})
            desc = exception.get("description", text)
            raise RuntimeError(f"JavaScript error: {desc}")

        # Extract the value
        remote_obj = result.get("result", {})
        if remote_obj.get("type") == "undefined":
            return None
        return remote_obj.get("value")

    def download(
        self,
        *,
        download_path: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str:
        """Enable downloads and return the download directory.

        After calling this method, any downloads triggered by page actions
        will be saved to the specified directory (or a temp directory).

        Uses ``allowAndName`` behavior so Chrome saves each download under a
        GUID-based filename, preventing overwrites during parallel downloads.
        The original filename is available via the ``Browser.downloadWillBegin``
        event's ``suggestedFilename`` field.

        Args:
            download_path: Directory to save downloads. Defaults to a temp dir.
            timeout: Timeout for the CDP command.

        Returns:
            The absolute path of the download directory.
        """
        path = download_path or _DOWNLOAD_DIR
        os.makedirs(path, exist_ok=True)

        # Use Browser.setDownloadBehavior via the browser client (no session)
        self._browser.send_sync(
            "Browser.setDownloadBehavior",
            {
                "behavior": "allowAndName",
                "downloadPath": path,
                "eventsEnabled": True,
            },
            timeout=timeout,
        )
        return path

    def close(self) -> None:
        """Close this tab.

        Called automatically when using ``chrome.new_page()`` as context manager.
        """
        if self._closed:
            return
        self._closed = True
        try:
            self._browser.send_sync(
                "Target.closeTarget", {"targetId": self._target_id}
            )
        except Exception:
            pass  # Best effort — tab might already be gone


def _js_string(s: str) -> str:
    """Escape a Python string for safe embedding in JavaScript.

    Returns the string wrapped in JSON quotes (double-quoted, with
    special characters escaped).
    """
    import json

    return json.dumps(s)
