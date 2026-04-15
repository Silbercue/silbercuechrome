"""Tests for CdpClient — CDP communication layer.

Tests are structured in three groups:
1. Unit tests (no Chrome needed) — test protocol logic with FakeWebSocket
2. Discovery tests — test HTTP endpoint parsing
3. Connect factory tests — test the connect() class method
"""

from __future__ import annotations

import asyncio
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from typing import Any
from unittest.mock import patch

import pytest

from silbercuechrome.cdp import CdpClient, CdpError
from tests.conftest import FakeWebSocket


# ---------------------------------------------------------------------------
# Helper: create a CdpClient wired to a FakeWebSocket with active listener
# ---------------------------------------------------------------------------


async def make_client(fake_ws: FakeWebSocket) -> CdpClient:
    """Create a CdpClient with an injected FakeWebSocket and active listener."""
    client = CdpClient("ws://fake:9222")
    client._ws = fake_ws
    client._closed = False
    client._listener_task = asyncio.create_task(client._listen())
    return client


# ---------------------------------------------------------------------------
# Unit Tests — Protocol Logic
# ---------------------------------------------------------------------------


class TestCdpClientSend:
    """Test send/receive protocol matching."""

    async def test_send_receives_matching_response(self, fake_ws: FakeWebSocket) -> None:
        """send() returns the result from the matching response."""
        client = await make_client(fake_ws)

        async def inject() -> None:
            await asyncio.sleep(0.02)
            fake_ws.inject_response(
                {"id": 1, "result": {"type": "number", "value": 2}}
            )

        asyncio.create_task(inject())
        result = await client.send(
            "Runtime.evaluate", {"expression": "1+1"}, timeout=2.0
        )

        assert result == {"type": "number", "value": 2}

        # Verify the sent message format
        sent = fake_ws.sent_messages
        assert len(sent) == 1
        assert sent[0]["method"] == "Runtime.evaluate"
        assert sent[0]["params"] == {"expression": "1+1"}
        assert sent[0]["id"] == 1

        await client.close()

    async def test_send_increments_ids(self, fake_ws: FakeWebSocket) -> None:
        """Each send() uses a unique incrementing ID."""
        client = await make_client(fake_ws)

        async def inject_responses() -> None:
            await asyncio.sleep(0.02)
            fake_ws.inject_response({"id": 1, "result": {}})
            await asyncio.sleep(0.02)
            fake_ws.inject_response({"id": 2, "result": {}})

        asyncio.create_task(inject_responses())

        await client.send("Method.one", timeout=2.0)
        await client.send("Method.two", timeout=2.0)

        sent = fake_ws.sent_messages
        assert sent[0]["id"] == 1
        assert sent[1]["id"] == 2

        await client.close()

    async def test_send_raises_cdp_error(self, fake_ws: FakeWebSocket) -> None:
        """send() raises CdpError when CDP returns an error response."""
        client = await make_client(fake_ws)

        async def inject() -> None:
            await asyncio.sleep(0.02)
            fake_ws.inject_response(
                {"id": 1, "error": {"code": -32601, "message": "Method not found"}}
            )

        asyncio.create_task(inject())

        with pytest.raises(CdpError) as exc_info:
            await client.send("Invalid.method", timeout=2.0)

        assert exc_info.value.code == -32601
        assert exc_info.value.method == "Invalid.method"
        assert "Invalid.method failed" in str(exc_info.value)
        assert "Method not found" in str(exc_info.value)

        await client.close()

    async def test_send_with_session_id(self, fake_ws: FakeWebSocket) -> None:
        """send() includes sessionId in the request when session_id is provided."""
        client = await make_client(fake_ws)

        async def inject() -> None:
            await asyncio.sleep(0.02)
            fake_ws.inject_response(
                {"id": 1, "result": {"result": {"type": "number", "value": 2}}}
            )

        asyncio.create_task(inject())
        await client.send(
            "Runtime.evaluate",
            {"expression": "1+1"},
            timeout=2.0,
            session_id="SESSION_ABC",
        )

        sent = fake_ws.sent_messages
        assert len(sent) == 1
        assert sent[0]["sessionId"] == "SESSION_ABC"
        assert sent[0]["method"] == "Runtime.evaluate"

        await client.close()

    async def test_send_without_session_id_omits_field(
        self, fake_ws: FakeWebSocket
    ) -> None:
        """send() omits sessionId when session_id is not provided."""
        client = await make_client(fake_ws)

        async def inject() -> None:
            await asyncio.sleep(0.02)
            fake_ws.inject_response({"id": 1, "result": {}})

        asyncio.create_task(inject())
        await client.send("Target.getTargets", timeout=2.0)

        sent = fake_ws.sent_messages
        assert "sessionId" not in sent[0]

        await client.close()

    async def test_send_timeout(self, fake_ws: FakeWebSocket) -> None:
        """send() raises TimeoutError if no response arrives."""
        client = await make_client(fake_ws)

        with pytest.raises(asyncio.TimeoutError):
            await client.send("Slow.method", timeout=0.05)

        await client.close()

    async def test_send_without_params(self, fake_ws: FakeWebSocket) -> None:
        """send() works without params (they are omitted, not null)."""
        client = await make_client(fake_ws)

        async def inject() -> None:
            await asyncio.sleep(0.02)
            fake_ws.inject_response({"id": 1, "result": {"targets": []}})

        asyncio.create_task(inject())

        result = await client.send("Target.getTargets", timeout=2.0)
        assert result == {"targets": []}

        sent = fake_ws.sent_messages
        assert "params" not in sent[0]

        await client.close()

    async def test_send_when_closed_raises(self) -> None:
        """send() raises ConnectionError on a closed client."""
        client = CdpClient("ws://fake:9222")
        client._closed = True

        with pytest.raises(ConnectionError):
            await client.send("Any.method")


class TestCdpClientEvents:
    """Test event subscription and dispatching."""

    async def test_event_handler_called(self, fake_ws: FakeWebSocket) -> None:
        """Registered event handlers are called with event params."""
        client = await make_client(fake_ws)

        received: list[dict[str, Any]] = []
        client.on("Page.loadEventFired", lambda params: received.append(params))

        fake_ws.inject_response(
            {"method": "Page.loadEventFired", "params": {"timestamp": 12345.0}}
        )

        await asyncio.sleep(0.05)
        assert len(received) == 1
        assert received[0]["timestamp"] == 12345.0

        await client.close()

    async def test_off_removes_handler(self, fake_ws: FakeWebSocket) -> None:
        """off() removes a previously registered handler."""
        client = await make_client(fake_ws)

        received: list[dict[str, Any]] = []
        handler = lambda params: received.append(params)

        client.on("Page.loadEventFired", handler)
        client.off("Page.loadEventFired", handler)

        fake_ws.inject_response(
            {"method": "Page.loadEventFired", "params": {"timestamp": 1.0}}
        )

        await asyncio.sleep(0.05)
        assert len(received) == 0

        await client.close()

    async def test_multiple_handlers(self, fake_ws: FakeWebSocket) -> None:
        """Multiple handlers for the same event all get called."""
        client = await make_client(fake_ws)

        results: list[str] = []
        client.on("Net.request", lambda p: results.append("A"))
        client.on("Net.request", lambda p: results.append("B"))

        fake_ws.inject_response({"method": "Net.request", "params": {}})

        await asyncio.sleep(0.05)
        assert results == ["A", "B"]

        await client.close()

    async def test_handler_exception_does_not_crash_listener(
        self, fake_ws: FakeWebSocket
    ) -> None:
        """An exception in a handler does not stop the listener."""
        client = await make_client(fake_ws)

        received: list[str] = []

        def bad_handler(params: dict[str, Any]) -> None:
            raise ValueError("boom")

        client.on("E.one", bad_handler)
        client.on("E.two", lambda p: received.append("ok"))

        fake_ws.inject_response({"method": "E.one", "params": {}})
        await asyncio.sleep(0.05)

        fake_ws.inject_response({"method": "E.two", "params": {}})
        await asyncio.sleep(0.05)

        # Listener survived the bad handler
        assert received == ["ok"]

        await client.close()


class TestCdpClientLifecycle:
    """Test connection lifecycle (close, context manager)."""

    async def test_close_sets_closed_flag(self, fake_ws: FakeWebSocket) -> None:
        """close() sets the closed flag."""
        client = await make_client(fake_ws)

        await client.close()
        assert client.closed is True

    async def test_async_context_manager(self, fake_ws: FakeWebSocket) -> None:
        """CdpClient works as async context manager."""
        client = await make_client(fake_ws)

        async with client as c:
            assert c is client
            assert not c.closed

        assert client.closed

    async def test_close_cancels_pending_futures(self, fake_ws: FakeWebSocket) -> None:
        """close() cancels all pending futures."""
        client = await make_client(fake_ws)

        # Add a pending future manually
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        client._pending[99] = fut

        await client.close()

        # The future should be cancelled and pending dict cleared
        assert fut.done()
        assert fut.cancelled()
        assert len(client._pending) == 0


# ---------------------------------------------------------------------------
# Discovery Tests — HTTP endpoint parsing
# ---------------------------------------------------------------------------


class TestDiscoverBrowserWs:
    """Test _discover_browser_ws with a real HTTP server."""

    def _start_server(
        self, response_body: dict[str, Any] | None = None, status: int = 200
    ) -> tuple[HTTPServer, int]:
        """Start a minimal HTTP server returning JSON."""

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                body = json.dumps(response_body or {}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                pass  # Suppress output

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, port

    def test_discover_returns_ws_url(self) -> None:
        """Parses webSocketDebuggerUrl from /json/version."""
        expected_url = "ws://127.0.0.1:9222/devtools/browser/abc123"
        server, port = self._start_server(
            {"webSocketDebuggerUrl": expected_url, "Browser": "Chrome/120"}
        )
        try:
            result = CdpClient._discover_browser_ws("127.0.0.1", port)
            assert result == expected_url
        finally:
            server.shutdown()

    def test_discover_missing_field_raises(self) -> None:
        """Raises ConnectionError if webSocketDebuggerUrl is missing."""
        server, port = self._start_server({"Browser": "Chrome/120"})
        try:
            with pytest.raises(ConnectionError, match="No webSocketDebuggerUrl"):
                CdpClient._discover_browser_ws("127.0.0.1", port)
        finally:
            server.shutdown()

    def test_discover_unreachable_raises(self) -> None:
        """Raises ConnectionError if Chrome is not running."""
        with pytest.raises(ConnectionError, match="Cannot reach Chrome"):
            CdpClient._discover_browser_ws("127.0.0.1", 19999)


# ---------------------------------------------------------------------------
# CdpError Tests
# ---------------------------------------------------------------------------


class TestCdpError:
    """Test CdpError exception."""

    def test_error_attributes(self) -> None:
        err = CdpError(code=-32601, message="Method not found", data={"detail": "x"})
        assert err.code == -32601
        assert err.message == "Method not found"
        assert err.data == {"detail": "x"}
        assert err.method is None
        assert "-32601" in str(err)
        assert "Method not found" in str(err)

    def test_error_without_data(self) -> None:
        err = CdpError(code=-1, message="Unknown")
        assert err.data is None
        assert err.method is None

    def test_error_with_method(self) -> None:
        """CdpError includes the CDP method name when provided."""
        err = CdpError(
            code=-32000, message="Object not found", method="Runtime.evaluate"
        )
        assert err.method == "Runtime.evaluate"
        assert "Runtime.evaluate failed" in str(err)
        assert "-32000" in str(err)
        assert "Object not found" in str(err)


# ---------------------------------------------------------------------------
# Connect Factory Tests
# ---------------------------------------------------------------------------


class _FakeConnectCtx:
    """Async context manager that returns a FakeWebSocket for patching `connect`."""

    def __init__(self, ws: FakeWebSocket) -> None:
        self._ws = ws

    async def __aenter__(self) -> FakeWebSocket:
        return self._ws

    async def __aexit__(self, *exc: Any) -> None:
        pass


class TestCdpClientConnect:
    """Test the connect() class method."""

    async def test_connect_with_explicit_ws_url(self, fake_ws: FakeWebSocket) -> None:
        """connect() with ws_url skips discovery."""
        with patch(
            "silbercuechrome.cdp.connect",
            return_value=_FakeConnectCtx(fake_ws),
        ):
            client = await CdpClient.connect(ws_url="ws://fake:9222/devtools/browser/x")
            assert not client.closed
            await client.close()

    async def test_connect_with_target_id(self, fake_ws: FakeWebSocket) -> None:
        """connect() with target_id builds page-level URL."""
        captured_urls: list[str] = []

        def mock_connect(url: str, **kwargs: Any) -> _FakeConnectCtx:
            captured_urls.append(url)
            return _FakeConnectCtx(fake_ws)

        with patch("silbercuechrome.cdp.connect", side_effect=mock_connect):
            client = await CdpClient.connect(
                host="myhost", port=1234, target_id="ABCDEF"
            )
            assert captured_urls[0] == "ws://myhost:1234/devtools/page/ABCDEF"
            await client.close()

    async def test_connect_discovers_browser_ws(self, fake_ws: FakeWebSocket) -> None:
        """connect() without target_id calls _discover_browser_ws."""
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
            client = await CdpClient.connect(host="localhost", port=9222)
            assert not client.closed
            await client.close()


# ---------------------------------------------------------------------------
# Response matching edge cases
# ---------------------------------------------------------------------------


class TestResponseMatching:
    """Test edge cases in response/event dispatching."""

    async def test_unmatched_id_ignored(self, fake_ws: FakeWebSocket) -> None:
        """Responses with unknown IDs are silently ignored."""
        client = await make_client(fake_ws)

        fake_ws.inject_response({"id": 999, "result": {}})
        await asyncio.sleep(0.05)

        # No crash, listener still alive
        assert not client._listener_task.done()
        await client.close()

    async def test_non_json_message_ignored(self, fake_ws: FakeWebSocket) -> None:
        """Non-JSON messages are logged and ignored."""
        client = await make_client(fake_ws)

        fake_ws._incoming.put_nowait("not json at all")
        await asyncio.sleep(0.05)

        assert not client._listener_task.done()
        await client.close()

    async def test_result_without_result_field(self, fake_ws: FakeWebSocket) -> None:
        """Response with id but no result field returns empty dict."""
        client = await make_client(fake_ws)

        async def inject() -> None:
            await asyncio.sleep(0.02)
            fake_ws.inject_response({"id": 1})

        asyncio.create_task(inject())

        result = await client.send("Some.method", timeout=2.0)
        assert result == {}

        await client.close()

    async def test_event_without_params(self, fake_ws: FakeWebSocket) -> None:
        """Events without params field pass empty dict to handler."""
        client = await make_client(fake_ws)

        received: list[dict[str, Any]] = []
        client.on("E.test", lambda p: received.append(p))

        fake_ws.inject_response({"method": "E.test"})
        await asyncio.sleep(0.05)

        assert received == [{}]
        await client.close()

    async def test_concurrent_sends(self, fake_ws: FakeWebSocket) -> None:
        """Multiple concurrent sends match responses correctly."""
        client = await make_client(fake_ws)

        async def inject() -> None:
            await asyncio.sleep(0.02)
            # Respond out of order
            fake_ws.inject_response({"id": 2, "result": {"val": "B"}})
            fake_ws.inject_response({"id": 1, "result": {"val": "A"}})

        asyncio.create_task(inject())

        r1, r2 = await asyncio.gather(
            client.send("M.one", timeout=2.0),
            client.send("M.two", timeout=2.0),
        )

        assert r1 == {"val": "A"}
        assert r2 == {"val": "B"}

        await client.close()


# ---------------------------------------------------------------------------
# CancelledError → ConnectionError mapping (H4)
# ---------------------------------------------------------------------------


class TestCancelledErrorMapping:
    """Test that CancelledError in listener maps to ConnectionError."""

    async def test_cancelled_listener_raises_connection_error(
        self, fake_ws: FakeWebSocket
    ) -> None:
        """When the listener task is cancelled, pending sends get ConnectionError."""
        client = await make_client(fake_ws)

        # Start a send that will never get a response
        send_task = asyncio.create_task(client.send("Slow.method", timeout=5.0))
        await asyncio.sleep(0.02)  # Let it register the pending future

        # Cancel the listener (simulates connection drop)
        assert client._listener_task is not None
        client._listener_task.cancel()
        await asyncio.sleep(0.05)  # Let cancellation propagate

        with pytest.raises(ConnectionError, match="connection lost"):
            await send_task

        await client.close()


# ---------------------------------------------------------------------------
# Sync API Tests (H1)
# ---------------------------------------------------------------------------


class TestSyncApi:
    """Test synchronous wrapper methods."""

    def test_send_sync_without_connect_sync_raises(self) -> None:
        """send_sync() raises RuntimeError if client wasn't created with connect_sync()."""
        client = CdpClient("ws://fake:9222")
        with pytest.raises(RuntimeError, match="No sync event loop"):
            client.send_sync("Any.method")

    def test_close_sync_without_connect_sync_raises(self) -> None:
        """close_sync() raises RuntimeError if client wasn't created with connect_sync()."""
        client = CdpClient("ws://fake:9222")
        with pytest.raises(RuntimeError, match="No sync event loop"):
            client.close_sync()

    def test_connect_sync_and_send_sync(self, fake_ws: FakeWebSocket) -> None:
        """connect_sync + send_sync + close_sync round-trip works."""

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
            client = CdpClient.connect_sync(host="localhost", port=9222)
            assert not client.closed
            assert hasattr(client, "_sync_loop")
            assert client._sync_loop is not None

            # Inject response via the sync loop's thread so the asyncio.Queue
            # operations happen on the correct event loop.
            bg_loop = client._sync_loop

            def inject() -> None:
                import time

                time.sleep(0.05)
                bg_loop.call_soon_threadsafe(
                    fake_ws._incoming.put_nowait,
                    json.dumps({"id": 1, "result": {"ok": True}}),
                )

            threading.Thread(target=inject, daemon=True).start()

            result = client.send_sync("Test.method", timeout=2.0)
            assert result == {"ok": True}

            client.close_sync()
            assert client.closed

    def test_sync_context_manager(self, fake_ws: FakeWebSocket) -> None:
        """CdpClient works as sync context manager with connect_sync."""
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
            client = CdpClient.connect_sync(host="localhost", port=9222)
            with client as c:
                assert c is client
                assert not c.closed
            assert client.closed
