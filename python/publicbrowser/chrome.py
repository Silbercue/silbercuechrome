"""Chrome — entry point for browser automation (v2 — Shared Core Client).

Provides the top-level ``Chrome`` class that connects to the Public Browser
Script API server and manages tab lifecycle via ``new_page()``.

In v2, all browser automation logic runs server-side. The Python library is a
thin HTTP client that sends tool calls to the server on port 9223.

Usage::

    from publicbrowser import Chrome

    chrome = Chrome.connect()
    with chrome.new_page() as page:
        page.navigate("https://example.com")
        title = page.evaluate("document.title")
        print(title)
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any, Generator

from publicbrowser.client import ScriptApiClient
from publicbrowser.page import Page


class Chrome:
    """Connection to the Public Browser Script API server.

    Use ``Chrome.connect()`` to create an instance. Do not instantiate directly.

    The Chrome object holds an HTTP client for the Script API and can create
    new tabs via ``new_page()``. If no server is running, it auto-starts one.
    """

    def __init__(self, client: ScriptApiClient) -> None:
        self._client = client
        self._closed = False

    @classmethod
    def connect(
        cls,
        host: str = "localhost",
        port: int = 9223,
        *,
        server_path: str | None = None,
        auto_start: bool = True,
    ) -> Chrome:
        """Connect to the Public Browser Script API server.

        If the server is not running and ``auto_start`` is True, starts it
        automatically as a subprocess.

        Args:
            host: Server host (default: localhost).
            port: Server port (default: 9223).
            server_path: Explicit path to the server binary. If not given,
                the server is found via PATH or npx fallback.
            auto_start: Whether to auto-start the server if not running
                (default: True).

        Returns:
            A connected Chrome instance.

        Raises:
            ConnectionError: If the server is not reachable and auto_start
                is False.
            FileNotFoundError: If auto_start is True but no server binary
                can be found.
            TimeoutError: If the auto-started server does not become ready.
        """
        client = ScriptApiClient(host, port)

        if not client._is_server_running():
            if auto_start:
                client.start_server(server_path=server_path)
            else:
                raise ConnectionError(
                    f"Public Browser server not reachable on {host}:{port}. "
                    f"Start it with 'public-browser --script' or set auto_start=True."
                )

        return cls(client)

    @contextmanager
    def new_page(self) -> Generator[Page, None, None]:
        """Create a new tab and return a Page as a context manager.

        The session (tab) is automatically closed when the context manager
        exits, even if an exception occurs.

        Yields:
            A Page instance for the new tab.

        Example::

            with chrome.new_page() as page:
                page.navigate("https://example.com")
                page.click("#button")
        """
        session_token, target_id, cdp_ws_url, cdp_session_id = (
            self._client.create_session()
        )

        page = Page(
            client=self._client,
            session_token=session_token,
            target_id=target_id,
            cdp_ws_url=cdp_ws_url,
            cdp_session_id=cdp_session_id,
        )

        try:
            yield page
        finally:
            try:
                page.close()  # Close Escape Hatch WebSocket if open
            except Exception:
                pass
            try:
                self._client.close_session(session_token)
            except Exception:
                pass  # Cleanup errors must not propagate

    @property
    def closed(self) -> bool:
        """Whether the Chrome connection is closed."""
        return self._closed

    def close(self) -> None:
        """Close the connection and terminate any auto-started server.

        Does NOT close Chrome itself — only the HTTP client and any
        auto-started server subprocess.
        """
        if self._closed:
            return
        self._closed = True
        self._client.close()

    def __enter__(self) -> Chrome:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
