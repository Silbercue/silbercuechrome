"""Tests for Chrome — browser connection and tab lifecycle.

Tests are structured in groups:
1. Chrome.connect() — connection factory
2. chrome.new_page() — context manager for tab lifecycle
3. Chrome lifecycle — close, context manager
"""

from __future__ import annotations

import json
import threading
from typing import Any
from unittest.mock import patch, MagicMock

import pytest

from silbercuechrome.cdp import CdpClient
from silbercuechrome.chrome import Chrome
from silbercuechrome.page import Page
from tests.conftest import FakeWebSocket


# ---------------------------------------------------------------------------
# Helper: create a fake Chrome with FakeWebSocket
# ---------------------------------------------------------------------------

class _FakeConnectCtx:
    """Async context manager that returns a FakeWebSocket."""

    def __init__(self, ws: FakeWebSocket) -> None:
        self._ws = ws

    async def __aenter__(self) -> FakeWebSocket:
        return self._ws

    async def __aexit__(self, *exc: Any) -> None:
        pass


def make_chrome(fake_ws: FakeWebSocket) -> Chrome:
    """Create a Chrome instance with a FakeWebSocket-backed CdpClient."""
    with (
        patch.object(
            CdpClient,
            "_discover_browser_ws",
            return_value="ws://localhost:9222/devtools/browser/xyz",
        ),
        patch(
            "silbercuechrome.cdp.connect",
            return_value=_FakeConnectCtx(fake_ws),
        ),
    ):
        return Chrome.connect(port=9222)


def inject_from_thread(fake_ws: FakeWebSocket, loop: Any, messages: list[dict[str, Any]], delay: float = 0.03) -> None:
    """Inject responses from a background thread (for sync API tests)."""
    import time

    def _inject() -> None:
        for i, msg in enumerate(messages):
            time.sleep(delay)
            loop.call_soon_threadsafe(
                fake_ws._incoming.put_nowait,
                json.dumps(msg),
            )

    threading.Thread(target=_inject, daemon=True).start()


# ---------------------------------------------------------------------------
# Chrome.connect() Tests
# ---------------------------------------------------------------------------


class TestChromeConnect:
    """Test Chrome.connect() factory method."""

    def test_connect_returns_chrome_instance(self, fake_ws: FakeWebSocket) -> None:
        """Chrome.connect() returns a connected Chrome instance."""
        chrome = make_chrome(fake_ws)
        assert isinstance(chrome, Chrome)
        assert not chrome.closed
        chrome.close()

    def test_connect_with_custom_host_port(self, fake_ws: FakeWebSocket) -> None:
        """Chrome.connect() passes host and port to CdpClient."""
        with (
            patch.object(
                CdpClient,
                "_discover_browser_ws",
                return_value="ws://myhost:1234/devtools/browser/abc",
            ) as mock_discover,
            patch(
                "silbercuechrome.cdp.connect",
                return_value=_FakeConnectCtx(fake_ws),
            ),
        ):
            chrome = Chrome.connect(host="myhost", port=1234)
            mock_discover.assert_called_once_with("myhost", 1234)
            chrome.close()

    def test_connect_unreachable_raises(self) -> None:
        """Chrome.connect() raises ConnectionError if Chrome is not running."""
        with pytest.raises(ConnectionError):
            Chrome.connect(port=19999)


# ---------------------------------------------------------------------------
# chrome.new_page() Tests
# ---------------------------------------------------------------------------


class TestNewPage:
    """Test chrome.new_page() context manager."""

    def test_new_page_creates_and_closes_tab(self, fake_ws: FakeWebSocket) -> None:
        """new_page() creates a tab on enter and closes it on exit."""
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        # Inject responses for:
        # 1. Target.createTarget -> targetId
        # 2. Target.attachToTarget -> sessionId
        # 3. Target.closeTarget (on exit)
        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "TAB_123"}},
            {"id": 2, "result": {"sessionId": "SESSION_ABC"}},
        ])

        with chrome.new_page() as page:
            assert isinstance(page, Page)
            assert page.target_id == "TAB_123"
            assert not page.closed

            # Inject the closeTarget response for context exit
            inject_from_thread(fake_ws, loop, [
                {"id": 3, "result": {"success": True}},
            ], delay=0.01)

        assert page.closed

        # Verify the sent messages
        sent = fake_ws.sent_messages
        assert sent[0]["method"] == "Target.createTarget"
        assert sent[0]["params"]["url"] == "about:blank"
        assert sent[1]["method"] == "Target.attachToTarget"
        assert sent[1]["params"]["targetId"] == "TAB_123"
        assert sent[1]["params"]["flatten"] is True
        assert sent[2]["method"] == "Target.closeTarget"
        assert sent[2]["params"]["targetId"] == "TAB_123"

        chrome.close()

    def test_new_page_with_custom_url(self, fake_ws: FakeWebSocket) -> None:
        """new_page(url=...) passes the URL to Target.createTarget."""
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "TAB_456"}},
            {"id": 2, "result": {"sessionId": "SESSION_DEF"}},
        ])

        with chrome.new_page(url="https://example.com") as page:
            assert page.target_id == "TAB_456"
            inject_from_thread(fake_ws, loop, [
                {"id": 3, "result": {"success": True}},
            ], delay=0.01)

        sent = fake_ws.sent_messages
        assert sent[0]["params"]["url"] == "https://example.com"

        chrome.close()

    def test_new_page_closes_tab_on_exception(self, fake_ws: FakeWebSocket) -> None:
        """new_page() closes the tab even if an exception occurs inside the block."""
        chrome = make_chrome(fake_ws)
        loop = chrome._client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"targetId": "TAB_ERR"}},
            {"id": 2, "result": {"sessionId": "SESSION_ERR"}},
        ])

        with pytest.raises(ValueError, match="test error"):
            with chrome.new_page() as page:
                # Inject closeTarget response for the finally block
                inject_from_thread(fake_ws, loop, [
                    {"id": 3, "result": {"success": True}},
                ], delay=0.01)
                raise ValueError("test error")

        assert page.closed

        chrome.close()


# ---------------------------------------------------------------------------
# Chrome lifecycle Tests
# ---------------------------------------------------------------------------


class TestChromeLifecycle:
    """Test Chrome close and context manager."""

    def test_close_sets_closed_flag(self, fake_ws: FakeWebSocket) -> None:
        """close() sets the closed flag."""
        chrome = make_chrome(fake_ws)
        chrome.close()
        assert chrome.closed

    def test_double_close_is_safe(self, fake_ws: FakeWebSocket) -> None:
        """Calling close() twice does not raise."""
        chrome = make_chrome(fake_ws)
        chrome.close()
        chrome.close()  # Should not raise

    def test_context_manager(self, fake_ws: FakeWebSocket) -> None:
        """Chrome works as a context manager."""
        chrome = make_chrome(fake_ws)
        with chrome as c:
            assert c is chrome
            assert not c.closed
        assert chrome.closed
