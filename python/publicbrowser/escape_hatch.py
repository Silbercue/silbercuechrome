"""CdpEscapeHatch — direct CDP access for power users.

Provides raw CDP command execution bypassing the Script API server.
Uses the page-specific WebSocket URL to communicate directly with Chrome.

The Escape Hatch is a thin wrapper around CdpClient from cdp.py.
It connects lazily (first send() call) and routes all commands to the
correct tab via the page-specific WebSocket endpoint.

Usage::

    with chrome.new_page() as page:
        page.navigate("https://example.com")
        # Direct CDP access — bypasses the server entirely
        result = page.cdp.send("Runtime.evaluate", {"expression": "1+1"})
        print(result)  # {"result": {"type": "number", "value": 2}}
"""

from __future__ import annotations

from typing import Any, Callable

from publicbrowser.cdp import CdpClient, CdpError


class CdpEscapeHatch:
    """Direct CDP access for a single browser tab.

    Wraps CdpClient.connect_sync() with lazy connection management.
    The WebSocket connection is only established on the first send() call.

    Args:
        cdp_ws_url: Page-specific WebSocket URL
            (e.g. ``ws://localhost:9222/devtools/page/{targetId}``).
        cdp_session_id: Optional CDP session ID. Stored but NOT used
            automatically — when connecting to a page-specific URL
            (the default), Chrome routes commands to the correct tab
            without a session ID. Only relevant for power users who
            connect to the browser-level endpoint and need explicit
            session routing.
    """

    def __init__(self, cdp_ws_url: str, cdp_session_id: str | None = None) -> None:
        self._ws_url = cdp_ws_url
        # Store for power-user access but don't use automatically.
        # Page-specific WebSocket URLs route without session ID.
        self._stored_session_id = cdp_session_id
        self._client: CdpClient | None = None
        self._closed = False

    def send(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 30.0,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """Send a CDP command and return the result.

        Connects lazily on the first call. Subsequent calls reuse the
        same WebSocket connection.

        Args:
            method: CDP method name (e.g. ``"Runtime.evaluate"``).
            params: CDP method parameters.
            timeout: Maximum wait time in seconds.
            session_id: Explicit CDP session ID override. Default is
                ``None`` which lets Chrome route via the page-specific
                WebSocket URL (correct for most use cases).

        Returns:
            The ``result`` field from the CDP response.

        Raises:
            CdpError: If CDP returns an error response.
            ConnectionError: If the escape hatch has been closed or the
                WebSocket connection fails.
        """
        if self._closed:
            raise ConnectionError("Escape hatch closed — tab was closed")
        try:
            if self._client is None:
                self._client = CdpClient.connect_sync(ws_url=self._ws_url)
            return self._client.send_sync(
                method, params, timeout=timeout, session_id=session_id
            )
        except ConnectionError:
            raise
        except CdpError:
            raise
        except Exception as exc:
            raise ConnectionError(f"CDP WebSocket error: {exc}") from exc

    def on(self, event: str, handler: Callable[[dict[str, Any]], None]) -> None:
        """Register an event handler for a CDP event.

        Connects lazily if not yet connected.

        Args:
            event: CDP event name (e.g. ``"Network.requestWillBeSent"``).
            handler: Callback that receives the event params dict.

        Raises:
            ConnectionError: If the escape hatch has been closed.
        """
        if self._closed:
            raise ConnectionError("Escape hatch closed — tab was closed")
        if self._client is None:
            self._client = CdpClient.connect_sync(ws_url=self._ws_url)
        self._client.on(event, handler)

    def close(self) -> None:
        """Close the WebSocket connection.

        Safe to call multiple times (idempotent). After close(), further
        send() calls will raise ConnectionError.
        """
        self._closed = True
        if self._client is not None:
            self._client.close_sync()
            self._client = None

    @property
    def stored_session_id(self) -> str | None:
        """The stored CDP session ID (for power-user access).

        Not used automatically by ``send()`` — pass it explicitly via
        the ``session_id`` parameter if you need session-based routing
        on a browser-level WebSocket URL.
        """
        return self._stored_session_id

    @property
    def connected(self) -> bool:
        """Whether a WebSocket connection is currently open."""
        if self._closed:
            return False
        return self._client is not None and not self._client.closed
