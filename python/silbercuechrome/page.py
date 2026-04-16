"""Page — high-level API for a single browser tab (v2 — Shared Core Client).

A Page wraps a Script API session attached to a specific tab.
All browser automation logic runs server-side. Page methods send HTTP
tool calls and parse the MCP-format responses.

    with chrome.new_page() as page:
        page.navigate("https://example.com")
        page.click("#login")
        page.type("#user", "admin")

All public methods are synchronous.
"""

from __future__ import annotations

import json
from typing import Any

from silbercuechrome.client import ScriptApiClient, DEFAULT_TIMEOUT, LONG_TIMEOUT
from silbercuechrome.escape_hatch import CdpEscapeHatch


class Page:
    """High-level API for a single browser tab.

    Do not instantiate directly — use ``chrome.new_page()`` instead.

    Args:
        client: The ScriptApiClient for HTTP communication.
        session_token: The session token for this tab.
        target_id: The CDP target ID of this tab.
    """

    def __init__(
        self,
        client: ScriptApiClient,
        session_token: str,
        target_id: str,
        cdp_ws_url: str | None = None,
        cdp_session_id: str | None = None,
    ) -> None:
        self._client = client
        self._session_token = session_token
        self._target_id = target_id
        self._cdp_ws_url = cdp_ws_url
        self._cdp_session_id = cdp_session_id
        self._escape_hatch: CdpEscapeHatch | None = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _call_tool(
        self,
        name: str,
        params: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Send a tool call to the server and return the raw response."""
        return self._client.call_tool(
            name, params, self._session_token, timeout=timeout
        )

    @property
    def target_id(self) -> str:
        """The CDP target ID of this tab."""
        return self._target_id

    @property
    def session_token(self) -> str:
        """The session token for this tab."""
        return self._session_token

    @property
    def cdp(self) -> CdpEscapeHatch:
        """Direct CDP access for this tab (Escape Hatch).

        Returns a ``CdpEscapeHatch`` instance that communicates directly
        with Chrome via WebSocket, bypassing the Script API server.
        The instance is created lazily on first access and reused on
        subsequent accesses. The WebSocket connection itself is only
        opened on the first ``send()`` call.

        Raises:
            RuntimeError: If no CDP WebSocket URL is available.
        """
        if self._escape_hatch is None:
            if not self._cdp_ws_url:
                raise RuntimeError(
                    "CDP Escape Hatch not available — no cdp_ws_url. "
                    "Ensure the server supports Story 9.9."
                )
            self._escape_hatch = CdpEscapeHatch(
                self._cdp_ws_url, self._cdp_session_id
            )
        return self._escape_hatch

    # ------------------------------------------------------------------
    # Page methods
    # ------------------------------------------------------------------

    def navigate(self, url: str, *, timeout: float = LONG_TIMEOUT) -> None:
        """Navigate to a URL and wait for the page to load.

        Args:
            url: The URL to navigate to.
            timeout: Maximum wait time (seconds).

        Raises:
            RuntimeError: If navigation fails.
        """
        response = self._call_tool("navigate", {"url": url}, timeout=timeout)
        _check_error(response)

    def click(self, selector: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Click an element.

        The server handles selector resolution (CSS, visible text, ref),
        scroll-into-view, Shadow DOM traversal, and paint-order filtering.

        Args:
            selector: CSS selector, visible text, or ref (e.g. "ref:42").
            timeout: Timeout for the operation.

        Raises:
            RuntimeError: If the element is not found or click fails.
        """
        response = self._call_tool("click", {"selector": selector}, timeout=timeout)
        _check_error(response)

    def type(self, selector: str, text: str, *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Type text into an element.

        Args:
            selector: CSS selector, visible text, or ref for the input element.
            text: The text to type.
            timeout: Timeout for the operation.

        Raises:
            RuntimeError: If the element is not found.
        """
        response = self._call_tool(
            "type", {"selector": selector, "text": text}, timeout=timeout
        )
        _check_error(response)

    def fill(self, fields: dict[str, str], *, timeout: float = DEFAULT_TIMEOUT) -> None:
        """Fill multiple form fields at once.

        Args:
            fields: Mapping of selector to value.
            timeout: Timeout for the operation.

        Raises:
            RuntimeError: If any element is not found.
        """
        field_list = [
            {"selector": selector, "value": value}
            for selector, value in fields.items()
        ]
        response = self._call_tool("fill_form", {"fields": field_list}, timeout=timeout)
        _check_error(response)

    def wait_for(self, condition: str, *, timeout: float = LONG_TIMEOUT) -> None:
        """Wait for a condition to become truthy.

        The server handles all polling. Supports the same condition syntax
        as the MCP wait_for tool (JavaScript expressions, ``text=...`` shorthand).

        Args:
            condition: A JavaScript expression or ``text=<string>`` shorthand.
            timeout: Maximum wait time (seconds).

        Raises:
            TimeoutError: If the condition does not become truthy in time.
            RuntimeError: If the wait fails for other reasons.
        """
        # Map user-friendly condition string to server tool params.
        # Server expects: condition="element"|"network_idle"|"js"
        # plus selector= or expression= fields.
        # The HTTP gateway doesn't apply Zod schema defaults, so we must
        # always include timeout_ms explicitly (server expects milliseconds).
        timeout_ms = int(timeout * 1000)
        if condition == "network_idle":
            params: dict[str, Any] = {"condition": "network_idle", "timeout": timeout_ms}
        elif condition.startswith("text="):
            params = {"condition": "element", "selector": f"text/{condition[5:]}", "timeout": timeout_ms}
        elif condition.startswith(("#", ".", "[")) or condition.startswith("ref:"):
            params = {"condition": "element", "selector": condition, "timeout": timeout_ms}
        else:
            params = {"condition": "js", "expression": condition, "timeout": timeout_ms}
        response = self._call_tool("wait_for", params, timeout=timeout)
        # wait_for may return isError for timeouts
        if response.get("isError"):
            text = _extract_text(response)
            if "timeout" in text.lower() or "timed out" in text.lower():
                raise TimeoutError(text)
            raise RuntimeError(text)

    def evaluate(self, expression: str, *, timeout: float = DEFAULT_TIMEOUT) -> Any:
        """Evaluate JavaScript in the page context.

        Args:
            expression: JavaScript expression to evaluate.
            timeout: Timeout for the evaluation.

        Returns:
            The evaluated value. Attempts to parse JSON from the server
            response; returns the raw string if parsing fails.

        Raises:
            RuntimeError: If the evaluation throws an exception.
        """
        response = self._call_tool(
            "evaluate", {"expression": expression}, timeout=timeout
        )
        _check_error(response)
        return _parse_evaluate_response(response)

    def download(self, *, timeout: float = DEFAULT_TIMEOUT) -> str:
        """Enable downloads and return the download directory.

        Returns:
            The absolute path of the download directory.

        Raises:
            RuntimeError: If the operation fails.
        """
        response = self._call_tool("download", {}, timeout=timeout)
        _check_error(response)
        return _extract_text(response)

    def close(self) -> None:
        """Close the Escape Hatch WebSocket connection if open.

        The tab itself is not closed here — tab lifecycle is managed via
        session create/close. The context manager (Chrome.new_page()) calls
        close_session to close the tab.
        """
        if self._escape_hatch is not None:
            self._escape_hatch.close()
            self._escape_hatch = None


# ------------------------------------------------------------------
# Response parsing helpers
# ------------------------------------------------------------------


def _extract_text(response: dict[str, Any]) -> str:
    """Extract the text content from a MCP ToolResponse.

    The server response format is:
    ``{"content": [{"type": "text", "text": "..."}], "isError": false}``

    Returns:
        The text from the first content item, or empty string.
    """
    content = response.get("content", [])
    if content and isinstance(content, list) and len(content) > 0:
        return content[0].get("text", "")
    return ""


def _check_error(response: dict[str, Any]) -> None:
    """Check if the server response indicates an error.

    Args:
        response: The parsed server response.

    Raises:
        RuntimeError: If ``isError`` is true in the response.
    """
    if response.get("isError"):
        text = _extract_text(response)
        raise RuntimeError(text or "Unknown server error")


def _parse_evaluate_response(response: dict[str, Any]) -> Any:
    """Parse the evaluate tool response into a Python value.

    The server returns the JS value as serialized text. We try to parse
    it as JSON first (handles numbers, booleans, objects, arrays, null).
    If that fails, return the raw string.

    Returns:
        The parsed Python value (str, int, float, dict, list, None, bool).
    """
    text = _extract_text(response)
    if not text:
        return None

    # The server may append steering tips after the value, separated by
    # a blank line (e.g. "42\n\nTip: ..."). Strip those before parsing.
    if "\n\nTip:" in text:
        text = text[: text.index("\n\nTip:")]
    elif "\n\nNote:" in text:
        text = text[: text.index("\n\nNote:")]

    # Try JSON parse for structured values
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return text


def _parse_tool_response(response: dict[str, Any]) -> str:
    """Parse a generic tool response, returning the text content.

    This is a convenience alias for _extract_text used in tests.
    """
    return _extract_text(response)
