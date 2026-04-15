"""Chrome — entry point for browser automation.

Provides the top-level ``Chrome`` class that connects to a running Chrome
instance and manages tab lifecycle via ``new_page()``.

Usage::

    from silbercuechrome import Chrome

    chrome = Chrome.connect(port=9222)
    with chrome.new_page() as page:
        page.navigate("https://example.com")
        title = page.evaluate("document.title")
        print(title)
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from typing import Any, Generator

from silbercuechrome.cdp import CdpClient
from silbercuechrome.page import Page


class Chrome:
    """Connection to a Chrome browser instance.

    Use ``Chrome.connect()`` to create an instance. Do not instantiate directly.

    The Chrome object holds a browser-level CDP connection and can create
    new tabs via ``new_page()``.
    """

    def __init__(self, client: CdpClient) -> None:
        self._client = client
        self._closed = False

    @classmethod
    def connect(
        cls,
        host: str = "localhost",
        port: int = 9222,
    ) -> Chrome:
        """Connect to a running Chrome instance.

        Args:
            host: Chrome host (default: localhost).
            port: Chrome debugging port (default: 9222).

        Returns:
            A connected Chrome instance.

        Raises:
            ConnectionError: If Chrome is not reachable on the given port.
        """
        client = CdpClient.connect_sync(host=host, port=port)
        return cls(client)

    @contextmanager
    def new_page(self, url: str = "about:blank") -> Generator[Page, None, None]:
        """Create a new tab and return a Page as a context manager.

        The tab is automatically closed when the context manager exits,
        even if an exception occurs.

        Args:
            url: Initial URL for the new tab (default: about:blank).

        Yields:
            A Page instance for the new tab.

        Example::

            with chrome.new_page() as page:
                page.navigate("https://example.com")
                page.click("#button")
        """
        # Create a new tab
        result = self._client.send_sync(
            "Target.createTarget", {"url": url}
        )
        target_id = result["targetId"]

        # Attach to the new tab to get a session ID
        attach_result = self._client.send_sync(
            "Target.attachToTarget",
            {"targetId": target_id, "flatten": True},
        )
        session_id = attach_result["sessionId"]

        page = Page(
            browser_client=self._client,
            session_id=session_id,
            target_id=target_id,
        )

        try:
            yield page
        finally:
            page.close()

    @property
    def closed(self) -> bool:
        """Whether the Chrome connection is closed."""
        return self._closed

    def close(self) -> None:
        """Close the browser connection.

        Does NOT close Chrome itself — only the CDP WebSocket connection.
        """
        if self._closed:
            return
        self._closed = True
        self._client.close_sync()

    def __enter__(self) -> Chrome:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
