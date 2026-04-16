"""Tests for CdpEscapeHatch — direct CDP access for power users.

Tests are structured in groups:
1. Lazy-connect — no WebSocket until first send()
2. send() — delegates to CdpClient.send_sync()
3. Error handling — CdpError, ConnectionError
4. close() — WebSocket cleanup, idempotent
5. connected property
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch, MagicMock

import pytest

from silbercuechrome.cdp import CdpError
from silbercuechrome.escape_hatch import CdpEscapeHatch


# ---------------------------------------------------------------------------
# Helper: Mock CdpClient
# ---------------------------------------------------------------------------


def _make_mock_client(closed: bool = False) -> MagicMock:
    """Create a mock CdpClient with sensible defaults."""
    mock = MagicMock()
    mock.closed = closed
    mock.send_sync.return_value = {"result": {"type": "number", "value": 2}}
    return mock


# ---------------------------------------------------------------------------
# Lazy Connect Tests
# ---------------------------------------------------------------------------


class TestLazyConnect:
    """CdpEscapeHatch connects lazily — no WebSocket until first send()."""

    def test_no_connection_on_init(self) -> None:
        """Constructor does not open a WebSocket connection."""
        hatch = CdpEscapeHatch(
            "ws://localhost:9222/devtools/page/abc",
            "cdp-session-1",
        )
        assert hatch._client is None
        assert not hatch.connected

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_first_send_connects(self, mock_connect: MagicMock) -> None:
        """First send() call triggers WebSocket connection."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate", {"expression": "1+1"})

        mock_connect.assert_called_once_with(
            ws_url="ws://localhost:9222/devtools/page/abc"
        )

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_second_send_reuses_connection(self, mock_connect: MagicMock) -> None:
        """Subsequent send() calls reuse the existing connection."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate", {"expression": "1+1"})
        hatch.send("DOM.getDocument")

        # connect_sync called only once
        mock_connect.assert_called_once()
        # send_sync called twice
        assert mock_client.send_sync.call_count == 2


# ---------------------------------------------------------------------------
# send() Tests
# ---------------------------------------------------------------------------


class TestSend:
    """CdpEscapeHatch.send() delegates to CdpClient.send_sync()."""

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_send_returns_cdp_result(self, mock_connect: MagicMock) -> None:
        """send() returns the CDP result dict."""
        mock_client = _make_mock_client()
        mock_client.send_sync.return_value = {"result": {"type": "number", "value": 42}}
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        result = hatch.send("Runtime.evaluate", {"expression": "21*2"})

        assert result == {"result": {"type": "number", "value": 42}}

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_send_does_not_pass_stored_session_id(self, mock_connect: MagicMock) -> None:
        """send() does NOT auto-pass stored session_id — page URL routes automatically."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch(
            "ws://localhost:9222/devtools/page/abc",
            "cdp-session-xyz",
        )
        hatch.send("Network.enable", timeout=10.0)

        # session_id should be None (not the stored one)
        mock_client.send_sync.assert_called_once_with(
            "Network.enable", None, timeout=10.0, session_id=None
        )
        # Stored session_id is still accessible
        assert hatch.stored_session_id == "cdp-session-xyz"

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_send_explicit_session_id(self, mock_connect: MagicMock) -> None:
        """send() passes explicit session_id when provided."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Network.enable", session_id="explicit-sid", timeout=10.0)

        mock_client.send_sync.assert_called_once_with(
            "Network.enable", None, timeout=10.0, session_id="explicit-sid"
        )

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_send_passes_none_session_id(self, mock_connect: MagicMock) -> None:
        """send() passes session_id=None when not specified."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Page.enable")

        mock_client.send_sync.assert_called_once_with(
            "Page.enable", None, timeout=30.0, session_id=None
        )

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_send_passes_params(self, mock_connect: MagicMock) -> None:
        """send() passes params dict to CdpClient.send_sync()."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate", {"expression": "document.title"})

        mock_client.send_sync.assert_called_once_with(
            "Runtime.evaluate",
            {"expression": "document.title"},
            timeout=30.0,
            session_id=None,
        )


# ---------------------------------------------------------------------------
# Error Handling Tests
# ---------------------------------------------------------------------------


class TestErrorHandling:
    """CdpEscapeHatch error handling — CdpError, ConnectionError."""

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_cdp_error_propagates(self, mock_connect: MagicMock) -> None:
        """CdpError from CdpClient is propagated as-is."""
        mock_client = _make_mock_client()
        mock_client.send_sync.side_effect = CdpError(
            code=-32601, message="Method not found", method="UnknownDomain.method"
        )
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")

        with pytest.raises(CdpError, match="Method not found"):
            hatch.send("UnknownDomain.method")

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_connection_error_on_connect_failure(self, mock_connect: MagicMock) -> None:
        """ConnectionError when WebSocket connect fails."""
        mock_connect.side_effect = ConnectionError("Connection refused")

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")

        with pytest.raises(ConnectionError, match="Connection refused"):
            hatch.send("Runtime.evaluate")

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_connection_error_on_closed_websocket(self, mock_connect: MagicMock) -> None:
        """ConnectionError when WebSocket is closed (tab closed)."""
        mock_client = _make_mock_client()
        mock_client.send_sync.side_effect = ConnectionError(
            "CdpClient is not connected"
        )
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")

        with pytest.raises(ConnectionError, match="not connected"):
            hatch.send("Runtime.evaluate")


# ---------------------------------------------------------------------------
# close() Tests
# ---------------------------------------------------------------------------


class TestClose:
    """CdpEscapeHatch.close() — WebSocket cleanup."""

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_close_calls_client_close(self, mock_connect: MagicMock) -> None:
        """close() calls CdpClient.close_sync()."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate")  # trigger connect
        hatch.close()

        mock_client.close_sync.assert_called_once()
        assert hatch._client is None

    def test_close_without_connect_is_noop(self) -> None:
        """close() on a never-connected hatch is a no-op."""
        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.close()  # Should not raise
        assert hatch._client is None

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_double_close_is_idempotent(self, mock_connect: MagicMock) -> None:
        """Calling close() twice does not raise."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate")  # trigger connect
        hatch.close()
        hatch.close()  # Should not raise

        mock_client.close_sync.assert_called_once()


# ---------------------------------------------------------------------------
# connected Property Tests
# ---------------------------------------------------------------------------


class TestConnected:
    """CdpEscapeHatch.connected property."""

    def test_not_connected_initially(self) -> None:
        """connected is False before any send()."""
        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        assert not hatch.connected

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_connected_after_send(self, mock_connect: MagicMock) -> None:
        """connected is True after send()."""
        mock_client = _make_mock_client(closed=False)
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate")
        assert hatch.connected

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_not_connected_after_close(self, mock_connect: MagicMock) -> None:
        """connected is False after close()."""
        mock_client = _make_mock_client(closed=False)
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate")
        hatch.close()
        assert not hatch.connected


# ---------------------------------------------------------------------------
# on() Event Handler Tests
# ---------------------------------------------------------------------------


class TestEventHandler:
    """CdpEscapeHatch.on() — event handler registration."""

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_on_connects_lazily(self, mock_connect: MagicMock) -> None:
        """on() triggers WebSocket connection if not yet connected."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        handler = lambda params: None
        hatch.on("Network.requestWillBeSent", handler)

        mock_connect.assert_called_once()
        mock_client.on.assert_called_once_with("Network.requestWillBeSent", handler)

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_on_reuses_existing_connection(self, mock_connect: MagicMock) -> None:
        """on() reuses existing connection."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Network.enable")  # connect
        hatch.on("Network.requestWillBeSent", lambda p: None)

        # connect_sync called only once (during send)
        mock_connect.assert_called_once()

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_on_after_close_raises_connection_error(self, mock_connect: MagicMock) -> None:
        """on() after close() raises ConnectionError."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Network.enable")  # connect
        hatch.close()

        with pytest.raises(ConnectionError, match="closed"):
            hatch.on("Network.requestWillBeSent", lambda p: None)


# ---------------------------------------------------------------------------
# Closed-State Tests (H3/L1)
# ---------------------------------------------------------------------------


class TestClosedState:
    """After close(), send() must raise ConnectionError — no reconnect."""

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_send_after_close_raises_connection_error(self, mock_connect: MagicMock) -> None:
        """send() after close() raises ConnectionError immediately."""
        mock_client = _make_mock_client()
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate")  # trigger connect
        hatch.close()

        with pytest.raises(ConnectionError, match="closed"):
            hatch.send("Runtime.evaluate")

        # No reconnect attempt — connect_sync only called once (initial)
        mock_connect.assert_called_once()

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_send_after_close_without_prior_connect(self, mock_connect: MagicMock) -> None:
        """send() after close() on a never-connected hatch raises ConnectionError."""
        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.close()

        with pytest.raises(ConnectionError, match="closed"):
            hatch.send("Runtime.evaluate")

        # Never connected at all
        mock_connect.assert_not_called()

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_websocket_error_maps_to_connection_error(self, mock_connect: MagicMock) -> None:
        """Generic WebSocket exceptions during send() map to ConnectionError."""
        mock_client = _make_mock_client()
        mock_client.send_sync.side_effect = OSError("Connection reset by peer")
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")

        with pytest.raises(ConnectionError, match="CDP WebSocket error"):
            hatch.send("Runtime.evaluate")

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_cdp_error_not_wrapped(self, mock_connect: MagicMock) -> None:
        """CdpError is not wrapped in ConnectionError — it propagates as-is."""
        mock_client = _make_mock_client()
        mock_client.send_sync.side_effect = CdpError(
            code=-32601, message="Method not found", method="Foo.bar"
        )
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")

        with pytest.raises(CdpError, match="Method not found"):
            hatch.send("Foo.bar")

    @patch("silbercuechrome.escape_hatch.CdpClient.connect_sync")
    def test_connected_is_false_after_close(self, mock_connect: MagicMock) -> None:
        """connected property reflects the _closed flag."""
        mock_client = _make_mock_client(closed=False)
        mock_connect.return_value = mock_client

        hatch = CdpEscapeHatch("ws://localhost:9222/devtools/page/abc")
        hatch.send("Runtime.evaluate")
        assert hatch.connected

        hatch.close()
        assert not hatch.connected


# ---------------------------------------------------------------------------
# Integration Tests (H4)
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestEscapeHatchIntegration:
    """Integration tests — require a running Chrome + Script API server.

    Run with: pytest -m integration
    Skip with: pytest -m "not integration"
    """

    def test_escape_hatch_roundtrip_integration(self) -> None:
        """page.cdp.send() round-trip: Runtime.evaluate returns correct result."""
        from silbercuechrome import Chrome

        chrome = Chrome()
        with chrome.new_page() as page:
            page.navigate("about:blank")
            result = page.cdp.send(
                "Runtime.evaluate", {"expression": "1+1", "returnByValue": True}
            )
            assert result["result"]["value"] == 2

    def test_mixed_path_integration(self) -> None:
        """Shared Core (navigate) + Escape Hatch (Runtime.evaluate) on same tab."""
        from silbercuechrome import Chrome

        chrome = Chrome()
        with chrome.new_page() as page:
            # Shared Core path
            page.navigate("about:blank")
            # Escape Hatch path on the same tab
            result = page.cdp.send(
                "Runtime.evaluate",
                {"expression": "document.URL", "returnByValue": True},
            )
            assert "about:blank" in result["result"]["value"]
