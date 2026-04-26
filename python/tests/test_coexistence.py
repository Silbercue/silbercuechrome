"""CDP coexistence tests — Story 9.4 (updated for v2 Script API).

Verifies NFR19: MCP server and Python Script API can operate in parallel
without interference. Tests cover:

1. Script-tab lifecycle does not disturb MCP (AC #1, #2)
2. Context manager closes session on normal exit and on exception (AC #3)
3. Parallel Page objects operate in independent sessions (AC #1)

**Unit tests** (run with ``pytest``):
  Mock-based tests using a fake HTTP server — no Chrome needed. These verify
  the Python-side contract: correct HTTP requests are sent, context manager
  cleanup works, and parallel pages get different target IDs.

**Integration tests** (run with ``pytest -m integration``):
  Require a running SilbercueChrome server with ``--script`` flag.
  Skipped by default in ``pytest`` (no ``-m integration`` flag).
"""

from __future__ import annotations

import json
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from typing import Any
from unittest.mock import patch

import pytest

from publicbrowser.chrome import Chrome
from publicbrowser.client import ScriptApiClient
from publicbrowser.page import Page


# ---------------------------------------------------------------------------
# Helper: Fake HTTP server that mimics Script API responses
# ---------------------------------------------------------------------------

# Global counter for unique session/target IDs
_session_counter = 0


class _FakeScriptApiHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler that returns pre-configured responses."""

    responses: list[tuple[int, dict[str, Any]]] = []
    received_requests: list[tuple[str, dict[str, str], bytes]] = []

    def do_POST(self) -> None:
        global _session_counter
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        headers_dict = {k: v for k, v in self.headers.items()}
        _FakeScriptApiHandler.received_requests.append(
            (self.path, headers_dict, body)
        )

        if _FakeScriptApiHandler.responses:
            status, response_body = _FakeScriptApiHandler.responses.pop(0)
        else:
            # Default: auto-generate session responses
            if self.path == "/session/create":
                _session_counter += 1
                status = 200
                response_body = {
                    "session_token": f"SESSION-{_session_counter}",
                    "target_id": f"TARGET-{_session_counter}",
                    "cdp_ws_url": f"ws://localhost:9222/devtools/page/TARGET-{_session_counter}",
                    "cdp_session_id": f"cdp-session-{_session_counter}",
                }
            elif self.path == "/session/close":
                status = 200
                response_body = {"ok": True}
            else:
                status = 200
                response_body = {
                    "content": [{"type": "text", "text": "ok"}],
                    "isError": False,
                }

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
    """Start a fake Script API server."""
    global _session_counter
    _session_counter = 0
    _FakeScriptApiHandler.responses = []
    _FakeScriptApiHandler.received_requests = []

    server = HTTPServer(("127.0.0.1", 0), _FakeScriptApiHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    yield port

    server.shutdown()


def make_chrome(port: int) -> Chrome:
    """Create a Chrome instance connected to the fake server."""
    # _is_server_running will create+close a probe session, so we need
    # the fake server to handle those requests (handled by default auto-responses)
    return Chrome.connect(host="127.0.0.1", port=port, auto_start=False)


# ---------------------------------------------------------------------------
# Unit Tests — mock-based (no Chrome needed)
# ---------------------------------------------------------------------------


class TestScriptTabLifecycle:
    """Test that the Script API tab lifecycle is clean and isolated."""

    def test_new_page_creates_and_closes_tab_cleanly(self, fake_api: int) -> None:
        """new_page() creates a session and closes it on context exit.

        This is the fundamental contract: a script tab has a bounded lifecycle
        managed by the context manager. The MCP server never sees it because
        it only tracks tabs it created itself.
        """
        chrome = make_chrome(fake_api)

        with chrome.new_page() as page:
            assert page.target_id.startswith("TARGET-")
            assert page.session_token.startswith("SESSION-")

        # Verify create + close requests were sent
        paths = [r[0] for r in _FakeScriptApiHandler.received_requests]
        # First two are probe (create + close), then new_page (create), then exit (close)
        assert paths.count("/session/create") >= 2  # probe + new_page
        assert paths.count("/session/close") >= 2   # probe + new_page exit

        chrome.close()

    def test_context_manager_closes_tab_on_exception(self, fake_api: int) -> None:
        """Context manager __exit__ sends close_session even when an exception occurs.

        This guarantees AC #3: script sessions are cleaned up on both normal exit
        and exception paths.
        """
        chrome = make_chrome(fake_api)

        with pytest.raises(RuntimeError, match="simulated crash"):
            with chrome.new_page() as page:
                raise RuntimeError("simulated crash in script")

        # Verify close_session was still called
        close_requests = [
            r for r in _FakeScriptApiHandler.received_requests
            if r[0] == "/session/close"
        ]
        assert len(close_requests) >= 2  # probe close + crash cleanup close

        chrome.close()

    def test_context_manager_handles_already_closed_tab(self, fake_api: int) -> None:
        """__exit__ does not raise if close_session fails (e.g. server error).

        This tests the robustness of the cleanup: if the server returns an error
        on close, the context manager must not crash.
        """
        chrome = make_chrome(fake_api)

        # After probe (2 auto-responses) and new_page create (1 auto-response),
        # the exit close_session should get an error
        _FakeScriptApiHandler.responses = [
            # probe create
            (200, {"session_token": "PROBE", "target_id": "T0", "cdp_ws_url": "ws://localhost:9222/devtools/page/T0", "cdp_session_id": "cdp-0"}),
            # probe close
            (200, {"ok": True}),
            # new_page create
            (200, {"session_token": "GONE-SESSION", "target_id": "GONE-TAB", "cdp_ws_url": "ws://localhost:9222/devtools/page/GONE-TAB", "cdp_session_id": "cdp-gone"}),
            # new_page exit close — server error
            (500, {"error": "Internal server error"}),
        ]

        # Should NOT raise despite cleanup failure
        with chrome.new_page() as page:
            pass

        chrome.close()


class TestParallelPages:
    """Test that multiple Page objects operate in independent sessions."""

    def test_two_pages_have_different_target_ids(self, fake_api: int) -> None:
        """Two sequential new_page() calls create sessions with different target IDs.

        This verifies AC #1: parallel script operations get their own tabs
        and do not interfere with each other or MCP-owned tabs.
        """
        chrome = make_chrome(fake_api)

        with chrome.new_page() as page_a:
            target_a = page_a.target_id

        with chrome.new_page() as page_b:
            target_b = page_b.target_id

        assert target_a != target_b

        chrome.close()

    def test_page_operations_routed_to_correct_session(self, fake_api: int) -> None:
        """Tool calls from a Page are routed to its own session via X-Session header.

        This ensures that when two Pages exist, evaluate() on page A goes to
        session A's tab, not session B's tab.
        """
        # Use auto-responses for probe, then specific responses for the test
        chrome = make_chrome(fake_api)

        # After probe consumed auto-responses, set up specific responses
        # for new_page create, evaluate, and close
        _FakeScriptApiHandler.responses = [
            # new_page create
            (200, {"session_token": "SID-X", "target_id": "TAB-X", "cdp_ws_url": "ws://localhost:9222/devtools/page/TAB-X", "cdp_session_id": "cdp-x"}),
            # evaluate response
            (200, {"content": [{"type": "text", "text": '"hello"'}], "isError": False}),
            # new_page exit close
            (200, {"ok": True}),
        ]

        with chrome.new_page() as page:
            result = page.evaluate("'hello'")
            assert result == "hello"

        # Find the evaluate request and verify X-Session header
        eval_requests = [
            r for r in _FakeScriptApiHandler.received_requests
            if r[0] == "/tool/evaluate"
        ]
        assert len(eval_requests) == 1
        assert eval_requests[0][1]["X-Session"] == "SID-X"

        chrome.close()


class TestTabIsolation:
    """Test that script tabs do not interfere with each other or MCP state."""

    def test_script_tab_uses_own_session_token(self, fake_api: int) -> None:
        """Each script tab gets its own session token from the server.

        This is the mechanism that ensures isolation: HTTP calls are scoped
        to a session via X-Session header. The MCP server's sessions are
        completely separate.
        """
        # Use auto-responses for probe
        chrome = make_chrome(fake_api)

        # After probe consumed auto-responses, set up specific responses
        _FakeScriptApiHandler.responses = [
            # new_page create
            (200, {"session_token": "ISO-SESSION-UNIQUE", "target_id": "ISO-TAB", "cdp_ws_url": "ws://localhost:9222/devtools/page/ISO-TAB", "cdp_session_id": "cdp-iso"}),
            # new_page exit close
            (200, {"ok": True}),
        ]

        with chrome.new_page() as page:
            assert page.session_token == "ISO-SESSION-UNIQUE"

        chrome.close()

    def test_page_close_is_noop(self, fake_api: int) -> None:
        """Calling page.close() is a no-op in v2 — session lifecycle is managed by context manager."""
        chrome = make_chrome(fake_api)

        with chrome.new_page() as page:
            initial_count = len(_FakeScriptApiHandler.received_requests)
            page.close()
            page.close()  # Multiple calls are safe
            # No additional requests should be sent by page.close()
            assert len(_FakeScriptApiHandler.received_requests) == initial_count

        chrome.close()


# ---------------------------------------------------------------------------
# Integration Tests — require real SilbercueChrome server (skipped by default)
# ---------------------------------------------------------------------------

_CHROME_AVAILABLE = shutil.which("google-chrome") is not None or shutil.which(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
) is not None

_SKIP_REASON = (
    "Integration test requires SilbercueChrome server with --script flag. "
    "Start with: public-browser --script"
)


@pytest.mark.integration
@pytest.mark.skipif(not _CHROME_AVAILABLE, reason=_SKIP_REASON)
class TestCoexistenceIntegration:
    """End-to-end coexistence tests against a real SilbercueChrome server.

    Prerequisites:
      1. SilbercueChrome server running with ``--script`` flag
      2. Run with: ``pytest -m integration tests/test_coexistence.py -v``
    """

    def test_script_tab_lifecycle_real_chrome(self) -> None:
        """Create a session, navigate, evaluate, close — all against real server."""
        chrome = Chrome.connect()
        try:
            with chrome.new_page() as page:
                page.navigate("about:blank")
                result = page.evaluate("1 + 1")
                assert result == 2
        finally:
            chrome.close()

    def test_context_manager_cleanup_on_exception_real_chrome(self) -> None:
        """Verify session cleanup on exception with real server."""
        chrome = Chrome.connect()
        try:
            with pytest.raises(ValueError, match="test exception"):
                with chrome.new_page() as page:
                    raise ValueError("test exception")
        finally:
            chrome.close()

    def test_parallel_pages_different_targets_real_chrome(self) -> None:
        """Two pages have different target IDs on real server."""
        chrome = Chrome.connect()
        try:
            with chrome.new_page() as page_a:
                with chrome.new_page() as page_b:
                    assert page_a.target_id != page_b.target_id
                    page_a.navigate("about:blank")
                    page_b.navigate("about:blank")
        finally:
            chrome.close()
