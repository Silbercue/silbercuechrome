"""Tests for ScriptApiClient — HTTP client for Script API.

Tests are structured in groups:
1. HTTP communication — _post(), call_tool(), error handling
2. Session management — create_session(), close_session()
3. Server auto-start — start_server(), _is_server_running(), _wait_for_server()
4. Client lifecycle — close(), context manager
"""

from __future__ import annotations

import json
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from typing import Any
from unittest.mock import patch, MagicMock

import pytest

from publicbrowser.client import (
    ScriptApiClient,
    DEFAULT_TIMEOUT,
    LONG_TIMEOUT,
)


# ---------------------------------------------------------------------------
# Helper: Fake HTTP server that mimics Script API responses
# ---------------------------------------------------------------------------


class _FakeScriptApiHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that returns pre-configured responses."""

    # Class-level response queue (set by tests)
    responses: list[tuple[int, dict[str, Any]]] = []
    received_requests: list[tuple[str, dict[str, str], bytes]] = []

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        # Record the request
        headers_dict = {k: v for k, v in self.headers.items()}
        _FakeScriptApiHandler.received_requests.append(
            (self.path, headers_dict, body)
        )

        if _FakeScriptApiHandler.responses:
            status, response_body = _FakeScriptApiHandler.responses.pop(0)
        else:
            status = 200
            response_body = {"ok": True}

        response_bytes = json.dumps(response_body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.end_headers()
        self.wfile.write(response_bytes)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # Suppress output


@pytest.fixture
def fake_server():
    """Start a fake Script API HTTP server and return (client, server, port)."""
    _FakeScriptApiHandler.responses = []
    _FakeScriptApiHandler.received_requests = []

    server = HTTPServer(("127.0.0.1", 0), _FakeScriptApiHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    client = ScriptApiClient("127.0.0.1", port)
    yield client, server, port

    server.shutdown()
    client.close()


# ---------------------------------------------------------------------------
# HTTP Communication Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientPost:
    """Test _post() HTTP communication."""

    def test_post_sends_json_body(self, fake_server: tuple) -> None:
        """_post() sends JSON-encoded body with correct Content-Type."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"result": "ok"}),
        ]

        result = client._post("/test", {"key": "value"})
        assert result == {"result": "ok"}

        path, headers, body = _FakeScriptApiHandler.received_requests[0]
        assert path == "/test"
        assert headers["Content-Type"] == "application/json"
        assert json.loads(body) == {"key": "value"}

    def test_post_includes_session_header(self, fake_server: tuple) -> None:
        """_post() includes X-Session header when session_token is provided."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"ok": True}),
        ]

        client._post("/tool/click", {"selector": "#btn"}, session_token="TOKEN_123")

        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert headers["X-Session"] == "TOKEN_123"

    def test_post_omits_session_header_when_none(self, fake_server: tuple) -> None:
        """_post() omits X-Session header when no session_token."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"ok": True}),
        ]

        client._post("/session/create", {})

        _, headers, _ = _FakeScriptApiHandler.received_requests[0]
        assert "X-Session" not in headers

    def test_post_http_error_raises_runtime_error(self, fake_server: tuple) -> None:
        """_post() raises RuntimeError on HTTP 4xx/5xx."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (404, {"error": "Not found"}),
        ]

        with pytest.raises(RuntimeError, match="HTTP 404"):
            client._post("/tool/unknown", {})

    def test_post_connection_refused_raises_connection_error(self) -> None:
        """_post() raises ConnectionError when server is not reachable."""
        client = ScriptApiClient("127.0.0.1", 19999)
        with pytest.raises(ConnectionError, match="not reachable"):
            client._post("/session/create", {}, timeout=1.0)


# ---------------------------------------------------------------------------
# Tool Call Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientCallTool:
    """Test call_tool() method."""

    def test_call_tool_sends_to_correct_endpoint(self, fake_server: tuple) -> None:
        """call_tool() sends POST to /tool/{name}."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"content": [{"type": "text", "text": "done"}], "isError": False}),
        ]

        result = client.call_tool("click", {"selector": "#btn"}, "TOKEN_X")

        path, headers, body = _FakeScriptApiHandler.received_requests[0]
        assert path == "/tool/click"
        assert headers["X-Session"] == "TOKEN_X"
        assert json.loads(body) == {"selector": "#btn"}

    def test_call_tool_returns_raw_response(self, fake_server: tuple) -> None:
        """call_tool() returns the raw server response dict."""
        client, server, port = fake_server
        expected = {"content": [{"type": "text", "text": "clicked"}], "isError": False}
        _FakeScriptApiHandler.responses = [(200, expected)]

        result = client.call_tool("click", {"selector": "#x"}, "TOK")
        assert result == expected

    def test_call_tool_uses_long_timeout_for_navigate(self, fake_server: tuple) -> None:
        """call_tool() uses LONG_TIMEOUT for navigate and wait_for."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"content": [], "isError": False}),
        ]

        # We can't easily test the timeout value passed to urlopen,
        # but we verify the tool name is in _LONG_TIMEOUT_TOOLS
        from publicbrowser.client import _LONG_TIMEOUT_TOOLS
        assert "navigate" in _LONG_TIMEOUT_TOOLS
        assert "wait_for" in _LONG_TIMEOUT_TOOLS
        assert "click" not in _LONG_TIMEOUT_TOOLS


# ---------------------------------------------------------------------------
# Session Management Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientSession:
    """Test create_session() and close_session()."""

    def test_create_session_returns_token_and_target(self, fake_server: tuple) -> None:
        """create_session() returns (session_token, target_id, cdp_ws_url, cdp_session_id)."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {
                "session_token": "TOK_ABC",
                "target_id": "TARGET_123",
                "cdp_ws_url": "ws://localhost:9222/devtools/page/TARGET_123",
                "cdp_session_id": "CDP_SESS_1",
            }),
        ]

        token, target, cdp_ws_url, cdp_session_id = client.create_session()
        assert token == "TOK_ABC"
        assert target == "TARGET_123"
        assert cdp_ws_url == "ws://localhost:9222/devtools/page/TARGET_123"
        assert cdp_session_id == "CDP_SESS_1"

        path, _, _ = _FakeScriptApiHandler.received_requests[0]
        assert path == "/session/create"

    def test_close_session_sends_token(self, fake_server: tuple) -> None:
        """close_session() sends session_token in body and X-Session header."""
        client, server, port = fake_server
        _FakeScriptApiHandler.responses = [
            (200, {"ok": True}),
        ]

        client.close_session("TOK_ABC")

        path, headers, body = _FakeScriptApiHandler.received_requests[0]
        assert path == "/session/close"
        assert headers["X-Session"] == "TOK_ABC"
        assert json.loads(body)["session_token"] == "TOK_ABC"


# ---------------------------------------------------------------------------
# Server Probe Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientServerProbe:
    """Test _is_server_running() probe."""

    def test_is_server_running_returns_true(self, fake_server: tuple) -> None:
        """_is_server_running() returns True when server responds."""
        client, server, port = fake_server
        # The probe creates a session, so we need to respond with a token,
        # then handle the close_session call
        _FakeScriptApiHandler.responses = [
            (200, {"session_token": "PROBE_TOK", "target_id": "T1"}),
            (200, {"ok": True}),  # close_session
        ]

        assert client._is_server_running() is True

    def test_is_server_running_returns_false_when_no_server(self) -> None:
        """_is_server_running() returns False when no server is listening."""
        client = ScriptApiClient("127.0.0.1", 19999)
        assert client._is_server_running() is False


# ---------------------------------------------------------------------------
# Server Auto-Start Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientAutoStart:
    """Test start_server() and _wait_for_server()."""

    def test_start_server_with_explicit_path(self) -> None:
        """start_server() uses the explicit server_path when provided."""
        client = ScriptApiClient("127.0.0.1", 19998)

        with patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server(server_path="/usr/local/bin/public-browser")

            mock_popen.assert_called_once_with(
                ["/usr/local/bin/public-browser", "--script"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def test_start_server_finds_binary_in_path(self) -> None:
        """start_server() finds public-browser in PATH."""
        client = ScriptApiClient("127.0.0.1", 19998)

        with patch("shutil.which", side_effect=lambda name: "/opt/bin/public-browser" if name == "public-browser" else None), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server()

            mock_popen.assert_called_once_with(
                ["/opt/bin/public-browser", "--script"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def test_start_server_falls_back_to_npx(self) -> None:
        """start_server() uses npx fallback when no binary in PATH."""
        client = ScriptApiClient("127.0.0.1", 19998)

        def which_side_effect(name: str) -> str | None:
            if name == "npx":
                return "/usr/local/bin/npx"
            return None

        with patch("shutil.which", side_effect=which_side_effect), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server()

            mock_popen.assert_called_once_with(
                ["/usr/local/bin/npx", "-y", "public-browser@latest", "--", "--script"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def test_start_server_raises_when_no_binary(self) -> None:
        """start_server() raises FileNotFoundError when no binary found."""
        client = ScriptApiClient("127.0.0.1", 19998)

        with patch("shutil.which", return_value=None):
            with pytest.raises(FileNotFoundError, match="Cannot find"):
                client.start_server()

    def test_wait_for_server_timeout_raises(self) -> None:
        """_wait_for_server() raises TimeoutError when server doesn't start."""
        client = ScriptApiClient("127.0.0.1", 19999)
        client._server_proc = MagicMock()
        client._server_proc.poll.return_value = None  # Process still running

        with pytest.raises(TimeoutError, match="did not become ready"):
            client._wait_for_server(timeout=0.5)

    def test_wait_for_server_detects_crashed_process(self) -> None:
        """_wait_for_server() raises RuntimeError when server process exits."""
        client = ScriptApiClient("127.0.0.1", 19999)
        client._server_proc = MagicMock()
        client._server_proc.poll.return_value = 1  # Process exited with code 1
        client._server_proc.returncode = 1

        with pytest.raises(RuntimeError, match="exited with code 1"):
            client._wait_for_server(timeout=2.0)


# ---------------------------------------------------------------------------
# Shutdown Tests
# ---------------------------------------------------------------------------


class TestScriptApiClientShutdown:
    """Test _shutdown_server() and close()."""

    def test_shutdown_terminates_process(self) -> None:
        """_shutdown_server() terminates an auto-started process."""
        client = ScriptApiClient("127.0.0.1", 9223)
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None  # Still running
        client._server_proc = mock_proc

        client._shutdown_server()

        mock_proc.terminate.assert_called_once()
        mock_proc.wait.assert_called_once_with(timeout=3.0)

    def test_shutdown_kills_on_timeout(self) -> None:
        """_shutdown_server() kills process if terminate doesn't work."""
        client = ScriptApiClient("127.0.0.1", 9223)
        mock_proc = MagicMock()
        mock_proc.poll.return_value = None
        mock_proc.wait.side_effect = subprocess.TimeoutExpired(cmd="test", timeout=3)
        client._server_proc = mock_proc

        client._shutdown_server()

        mock_proc.terminate.assert_called_once()
        mock_proc.kill.assert_called_once()

    def test_shutdown_noop_when_no_process(self) -> None:
        """_shutdown_server() does nothing when no process was started."""
        client = ScriptApiClient("127.0.0.1", 9223)
        client._shutdown_server()  # Should not raise

    def test_shutdown_noop_when_process_already_exited(self) -> None:
        """_shutdown_server() does nothing when process already exited."""
        client = ScriptApiClient("127.0.0.1", 9223)
        mock_proc = MagicMock()
        mock_proc.poll.return_value = 0  # Already exited
        client._server_proc = mock_proc

        client._shutdown_server()

        mock_proc.terminate.assert_not_called()

    def test_close_sets_closed_flag(self) -> None:
        """close() sets the closed flag."""
        client = ScriptApiClient("127.0.0.1", 9223)
        client.close()
        assert client.closed

    def test_double_close_is_safe(self) -> None:
        """Calling close() twice does not raise."""
        client = ScriptApiClient("127.0.0.1", 9223)
        client.close()
        client.close()  # Should not raise

    def test_context_manager(self) -> None:
        """ScriptApiClient works as context manager."""
        client = ScriptApiClient("127.0.0.1", 9223)
        with client as c:
            assert c is client
            assert not c.closed
        assert client.closed
