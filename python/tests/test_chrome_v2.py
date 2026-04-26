"""Tests for Chrome v2 — Script API based browser connection and tab lifecycle.

Tests are structured in groups:
1. Chrome.connect() — connection factory with auto-start
2. chrome.new_page() — context manager for session lifecycle
3. Chrome lifecycle — close, context manager
"""

from __future__ import annotations

import json
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from typing import Any
from unittest.mock import patch, MagicMock

import pytest

from publicbrowser.chrome import Chrome
from publicbrowser.client import ScriptApiClient
from publicbrowser.page import Page


# ---------------------------------------------------------------------------
# Helper: Fake HTTP server that mimics Script API responses
# ---------------------------------------------------------------------------


class _FakeHandler(BaseHTTPRequestHandler):
    """Handler that returns pre-configured responses."""

    responses: list[tuple[int, dict[str, Any]]] = []
    received_requests: list[tuple[str, dict[str, str], bytes]] = []

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        headers_dict = {k: v for k, v in self.headers.items()}
        _FakeHandler.received_requests.append((self.path, headers_dict, body))

        if _FakeHandler.responses:
            status, response_body = _FakeHandler.responses.pop(0)
        else:
            status = 200
            response_body = {"ok": True}

        data = json.dumps(response_body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture
def fake_api():
    """Start a fake Script API server and return (port,)."""
    _FakeHandler.responses = []
    _FakeHandler.received_requests = []

    server = HTTPServer(("127.0.0.1", 0), _FakeHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    yield port, server

    server.shutdown()


# ---------------------------------------------------------------------------
# Chrome.connect() Tests
# ---------------------------------------------------------------------------


class TestChromeConnect:
    """Test Chrome.connect() factory method."""

    def test_connect_to_running_server(self, fake_api: tuple) -> None:
        """Chrome.connect() connects to a running server without starting one."""
        port, server = fake_api
        # _is_server_running probe: create_session + close_session
        _FakeHandler.responses = [
            (200, {"session_token": "PROBE_TOK", "target_id": "T1", "cdp_ws_url": "ws://localhost:9222/devtools/page/T1", "cdp_session_id": "cdp-1"}),
            (200, {"ok": True}),  # close probe session
        ]

        chrome = Chrome.connect(host="127.0.0.1", port=port, auto_start=False)
        assert isinstance(chrome, Chrome)
        assert not chrome.closed
        chrome.close()

    def test_connect_raises_when_no_server_and_no_auto_start(self) -> None:
        """Chrome.connect(auto_start=False) raises ConnectionError."""
        with pytest.raises(ConnectionError, match="not reachable"):
            Chrome.connect(host="127.0.0.1", port=19999, auto_start=False)

    def test_connect_auto_starts_server(self) -> None:
        """Chrome.connect() auto-starts the server when not running."""
        with patch.object(ScriptApiClient, "_is_server_running", return_value=False), \
             patch.object(ScriptApiClient, "start_server") as mock_start:
            chrome = Chrome.connect(host="127.0.0.1", port=19998)
            mock_start.assert_called_once_with(server_path=None)
            chrome.close()

    def test_connect_passes_server_path(self) -> None:
        """Chrome.connect(server_path=...) passes the path to start_server."""
        with patch.object(ScriptApiClient, "_is_server_running", return_value=False), \
             patch.object(ScriptApiClient, "start_server") as mock_start:
            chrome = Chrome.connect(
                host="127.0.0.1", port=19998,
                server_path="/custom/server"
            )
            mock_start.assert_called_once_with(server_path="/custom/server")
            chrome.close()

    def test_connect_skips_auto_start_when_server_running(self, fake_api: tuple) -> None:
        """Chrome.connect() does not start a server if one is already running."""
        port, server = fake_api
        _FakeHandler.responses = [
            (200, {"session_token": "PROBE_TOK", "target_id": "T1", "cdp_ws_url": "ws://localhost:9222/devtools/page/T1", "cdp_session_id": "cdp-1"}),
            (200, {"ok": True}),
        ]

        with patch.object(ScriptApiClient, "start_server") as mock_start:
            chrome = Chrome.connect(host="127.0.0.1", port=port)
            mock_start.assert_not_called()
            chrome.close()

    def test_connect_default_port_is_9223(self) -> None:
        """Chrome.connect() uses port 9223 by default."""
        with patch.object(ScriptApiClient, "_is_server_running", return_value=False), \
             patch.object(ScriptApiClient, "start_server"):
            chrome = Chrome.connect()
            assert chrome._client._port == 9223
            chrome.close()


# ---------------------------------------------------------------------------
# chrome.new_page() Tests
# ---------------------------------------------------------------------------


class TestNewPage:
    """Test chrome.new_page() context manager."""

    def test_new_page_creates_session_and_returns_page(self, fake_api: tuple) -> None:
        """new_page() creates a session and yields a Page."""
        port, server = fake_api
        _FakeHandler.responses = [
            # Probe: create_session + close for _is_server_running
            (200, {"session_token": "PROBE_TOK", "target_id": "T0", "cdp_ws_url": "ws://localhost:9222/devtools/page/T0", "cdp_session_id": "cdp-0"}),
            (200, {"ok": True}),
            # new_page: create_session
            (200, {"session_token": "SESSION_ABC", "target_id": "TARGET_123", "cdp_ws_url": "ws://localhost:9222/devtools/page/TARGET_123", "cdp_session_id": "cdp-abc"}),
            # new_page exit: close_session
            (200, {"ok": True}),
        ]

        chrome = Chrome.connect(host="127.0.0.1", port=port, auto_start=False)

        with chrome.new_page() as page:
            assert isinstance(page, Page)
            assert page.target_id == "TARGET_123"
            assert page.session_token == "SESSION_ABC"

        # Verify close_session was called
        close_requests = [
            r for r in _FakeHandler.received_requests if r[0] == "/session/close"
        ]
        assert len(close_requests) >= 1

        chrome.close()

    def test_new_page_closes_session_on_exception(self, fake_api: tuple) -> None:
        """new_page() closes the session even if an exception occurs."""
        port, server = fake_api
        _FakeHandler.responses = [
            # Probe
            (200, {"session_token": "PROBE_TOK", "target_id": "T0", "cdp_ws_url": "ws://localhost:9222/devtools/page/T0", "cdp_session_id": "cdp-0"}),
            (200, {"ok": True}),
            # new_page create
            (200, {"session_token": "SESSION_ERR", "target_id": "TARGET_ERR", "cdp_ws_url": "ws://localhost:9222/devtools/page/TARGET_ERR", "cdp_session_id": "cdp-err"}),
            # new_page close (on exception)
            (200, {"ok": True}),
        ]

        chrome = Chrome.connect(host="127.0.0.1", port=port, auto_start=False)

        with pytest.raises(ValueError, match="test error"):
            with chrome.new_page() as page:
                raise ValueError("test error")

        # Verify close_session was still called
        close_requests = [
            r for r in _FakeHandler.received_requests if r[0] == "/session/close"
        ]
        assert len(close_requests) >= 1

        chrome.close()

    def test_new_page_swallows_cleanup_error(self, fake_api: tuple) -> None:
        """new_page() does not propagate cleanup errors."""
        port, server = fake_api
        _FakeHandler.responses = [
            # Probe
            (200, {"session_token": "PROBE_TOK", "target_id": "T0", "cdp_ws_url": "ws://localhost:9222/devtools/page/T0", "cdp_session_id": "cdp-0"}),
            (200, {"ok": True}),
            # new_page create
            (200, {"session_token": "SESSION_X", "target_id": "TARGET_X", "cdp_ws_url": "ws://localhost:9222/devtools/page/TARGET_X", "cdp_session_id": "cdp-x"}),
            # new_page close — server returns error
            (500, {"error": "Internal server error"}),
        ]

        chrome = Chrome.connect(host="127.0.0.1", port=port, auto_start=False)

        # Should not raise despite cleanup failure
        with chrome.new_page() as page:
            pass

        chrome.close()


# ---------------------------------------------------------------------------
# Chrome lifecycle Tests
# ---------------------------------------------------------------------------


class TestChromeLifecycle:
    """Test Chrome close and context manager."""

    def test_close_sets_closed_flag(self) -> None:
        """close() sets the closed flag."""
        with patch.object(ScriptApiClient, "_is_server_running", return_value=True), \
             patch.object(ScriptApiClient, "create_session", return_value=("PROBE_TOK", "T0", "ws://localhost:9222/devtools/page/T0", "cdp-0")), \
             patch.object(ScriptApiClient, "close_session"):
            # Skip probe by patching _is_server_running
            chrome = Chrome.connect(host="127.0.0.1", port=19998)
            chrome.close()
            assert chrome.closed

    def test_double_close_is_safe(self) -> None:
        """Calling close() twice does not raise."""
        with patch.object(ScriptApiClient, "_is_server_running", return_value=True):
            chrome = Chrome.connect(host="127.0.0.1", port=19998)
            chrome.close()
            chrome.close()  # Should not raise

    def test_context_manager(self) -> None:
        """Chrome works as a context manager."""
        with patch.object(ScriptApiClient, "_is_server_running", return_value=True):
            chrome = Chrome.connect(host="127.0.0.1", port=19998)
            with chrome as c:
                assert c is chrome
                assert not c.closed
            assert chrome.closed

    def test_close_terminates_auto_started_server(self) -> None:
        """close() terminates the auto-started server process."""
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None

        with patch.object(ScriptApiClient, "_is_server_running", return_value=False), \
             patch.object(ScriptApiClient, "start_server"):
            chrome = Chrome.connect()
            # Simulate an auto-started server
            chrome._client._server_proc = mock_proc
            chrome.close()

            mock_proc.terminate.assert_called_once()
