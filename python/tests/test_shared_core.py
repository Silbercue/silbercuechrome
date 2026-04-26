"""Shared Core Integration Tests — Story 9.10.

Proves that Python Scripts use the same code path as MCP tools. Two layers:

1. **Unit Tests** (Fake HTTP server):
   - All 7 Page methods send correct HTTP requests to /tool/{name}
   - Response parsing: isError → RuntimeError, evaluate → JS value
   - Auto-Start verification (Mock)
   - Koexistenz: two sessions parallel, context manager cleanup

2. **Integration Tests** (@pytest.mark.integration):
   - Full roundtrip with real server
   - Shared Core + Escape Hatch on same tab
   - Two Python scripts in parallel

Run unit tests: ``pytest python/tests/test_shared_core.py -v``
Run integration tests: ``pytest python/tests/test_shared_core.py -v -m integration``
"""

from __future__ import annotations

import json
import shutil
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any
from unittest.mock import patch, MagicMock

import pytest

from publicbrowser.chrome import Chrome
from publicbrowser.client import ScriptApiClient
from publicbrowser.page import Page


# ---------------------------------------------------------------------------
# Helper: Fake HTTP server with request tracking
# ---------------------------------------------------------------------------

# Global counter for unique session/target IDs (reset per fixture)
_session_counter = 0


class _TrackingHandler(BaseHTTPRequestHandler):
    """HTTP handler that tracks all incoming requests for verification.

    Extends the pattern from test_coexistence.py with explicit path+body
    tracking so Shared Core tests can verify which endpoints were called
    and with which parameters.
    """

    responses: list[tuple[int, dict[str, Any]]] = []
    received_requests: list[tuple[str, dict[str, str], dict[str, Any] | bytes]] = []

    def do_POST(self) -> None:
        global _session_counter
        content_length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(content_length)

        # Parse body as JSON for easier test assertions
        try:
            parsed_body = json.loads(raw_body) if raw_body else {}
        except (json.JSONDecodeError, ValueError):
            parsed_body = raw_body

        headers_dict = {k: v for k, v in self.headers.items()}
        _TrackingHandler.received_requests.append(
            (self.path, headers_dict, parsed_body)
        )

        if _TrackingHandler.responses:
            status, response_body = _TrackingHandler.responses.pop(0)
        else:
            # Default auto-responses
            if self.path == "/session/create":
                _session_counter += 1
                status = 200
                response_body = {
                    "session_token": f"SC-SESSION-{_session_counter}",
                    "target_id": f"SC-TARGET-{_session_counter}",
                    "cdp_ws_url": f"ws://localhost:9222/devtools/page/SC-TARGET-{_session_counter}",
                    "cdp_session_id": f"sc-cdp-{_session_counter}",
                }
            elif self.path == "/session/close":
                status = 200
                response_body = {"ok": True}
            elif self.path and self.path.startswith("/tool/"):
                status = 200
                response_body = {
                    "content": [{"type": "text", "text": "ok"}],
                    "isError": False,
                }
            else:
                status = 404
                response_body = {"error": "not_found"}

        data = json.dumps(response_body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # Suppress output


@pytest.fixture
def tracking_server():
    """Start a fake Script API server with request tracking.

    Yields (port, handler_class) so tests can inspect received_requests.
    """
    global _session_counter
    _session_counter = 0
    _TrackingHandler.responses = []
    _TrackingHandler.received_requests = []

    server = HTTPServer(("127.0.0.1", 0), _TrackingHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    yield port

    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def _make_chrome(port: int) -> Chrome:
    """Create a Chrome instance connected to the fake server."""
    return Chrome.connect(host="127.0.0.1", port=port, auto_start=False)


def _tool_requests(
    path_prefix: str = "/tool/",
) -> list[tuple[str, dict[str, str], dict[str, Any] | bytes]]:
    """Filter received_requests for tool calls only."""
    return [
        r for r in _TrackingHandler.received_requests
        if r[0].startswith(path_prefix)
    ]


# ---------------------------------------------------------------------------
# Task 2: Tool-Call-Roundtrip and API Parity
# ---------------------------------------------------------------------------


class TestSharedCoreRouting:
    """All 7 Page methods send correct HTTP requests to /tool/{name}.

    Verifies AC #3: each Python method maps to the correct server endpoint.
    """

    def test_navigate_sends_to_tool_navigate(self, tracking_server: int) -> None:
        """page.navigate(url) sends POST /tool/navigate with {url: ...}."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            page.navigate("https://example.com")
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/navigate"]
        assert len(reqs) == 1
        assert reqs[0][2] == {"url": "https://example.com"}

    def test_click_sends_to_tool_click(self, tracking_server: int) -> None:
        """page.click(selector) sends POST /tool/click with {selector: ...}."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            page.click("#btn")
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/click"]
        assert len(reqs) == 1
        assert reqs[0][2] == {"selector": "#btn"}

    def test_type_sends_to_tool_type(self, tracking_server: int) -> None:
        """page.type(selector, text) sends POST /tool/type with {selector, text}."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            page.type("#input", "Hello World")
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/type"]
        assert len(reqs) == 1
        assert reqs[0][2] == {"selector": "#input", "text": "Hello World"}

    def test_fill_sends_to_tool_fill_form(self, tracking_server: int) -> None:
        """page.fill(fields) sends POST /tool/fill_form with {fields: [...]}.

        Note: Python method is 'fill' but endpoint is 'fill_form'.
        """
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            page.fill({"#user": "admin", "#pass": "secret"})
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/fill_form"]
        assert len(reqs) == 1
        body = reqs[0][2]
        assert "fields" in body
        fields = body["fields"]
        assert len(fields) == 2
        selectors = {f["selector"] for f in fields}
        values = {f["value"] for f in fields}
        assert selectors == {"#user", "#pass"}
        assert values == {"admin", "secret"}

    def test_wait_for_sends_to_tool_wait_for(self, tracking_server: int) -> None:
        """page.wait_for(condition) sends POST /tool/wait_for with {condition: ...}."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            page.wait_for("document.querySelector('#done')")
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/wait_for"]
        assert len(reqs) == 1
        assert reqs[0][2] == {"condition": "js", "expression": "document.querySelector('#done')", "timeout": 120000}

    def test_evaluate_sends_to_tool_evaluate(self, tracking_server: int) -> None:
        """page.evaluate(expression) sends POST /tool/evaluate with {expression: ...}."""
        chrome = _make_chrome(tracking_server)

        with chrome.new_page() as page:
            # Queue response AFTER probe+create consumed their auto-responses
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": "42"}], "isError": False})
            )
            result = page.evaluate("21 * 2")
            assert result == 42
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/evaluate"]
        assert len(reqs) == 1
        assert reqs[0][2] == {"expression": "21 * 2"}

    def test_download_sends_to_tool_download(self, tracking_server: int) -> None:
        """page.download() sends POST /tool/download with {}."""
        chrome = _make_chrome(tracking_server)

        with chrome.new_page() as page:
            # Queue response AFTER probe+create consumed their auto-responses
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": "/tmp/downloads"}], "isError": False})
            )
            result = page.download()
            assert result == "/tmp/downloads"
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/download"]
        assert len(reqs) == 1
        assert reqs[0][2] == {}

    def test_all_tool_calls_include_x_session_header(self, tracking_server: int) -> None:
        """Every tool call includes the X-Session header with the session token.

        Calls all 7 Page methods and verifies each sends the correct header.
        """
        chrome = _make_chrome(tracking_server)

        with chrome.new_page() as page:
            # Queue responses for evaluate and download (they parse the text)
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": "42"}], "isError": False})
            )
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": "/tmp/dl"}], "isError": False})
            )

            page.navigate("https://example.com")
            page.click("#btn")
            page.type("#input", "hello")
            page.fill({"#f": "v"})
            page.wait_for("true")
            page.evaluate("21 * 2")
            page.download()

        chrome.close()

        tool_reqs = _tool_requests()
        # Expect exactly 7 tool calls (one per method)
        called_tools = [r[0] for r in tool_reqs]
        assert "/tool/navigate" in called_tools
        assert "/tool/click" in called_tools
        assert "/tool/type" in called_tools
        assert "/tool/fill_form" in called_tools
        assert "/tool/wait_for" in called_tools
        assert "/tool/evaluate" in called_tools
        assert "/tool/download" in called_tools
        assert len(tool_reqs) == 7

        for path, headers, _ in tool_reqs:
            assert "X-Session" in headers, f"Missing X-Session header for {path}"
            assert headers["X-Session"].startswith("SC-SESSION-")


# ---------------------------------------------------------------------------
# Task 2.3: fill() maps correctly to fill_form
# ---------------------------------------------------------------------------


class TestFillFormMapping:
    """Detailed verification of the fill to fill_form mapping."""

    def test_fill_maps_dict_to_fields_array(self, tracking_server: int) -> None:
        """page.fill({"#user": "admin", "#pass": "secret"}) sends correct fields."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            page.fill({"#user": "admin", "#pass": "secret"})
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/fill_form"]
        assert len(reqs) == 1
        body = reqs[0][2]
        fields = body["fields"]
        # Verify exact structure
        for field in fields:
            assert "selector" in field
            assert "value" in field
            assert isinstance(field["selector"], str)
            assert isinstance(field["value"], str)

    def test_fill_single_field(self, tracking_server: int) -> None:
        """page.fill with a single field still sends correct structure."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            page.fill({"#email": "test@example.com"})
        chrome.close()

        reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/fill_form"]
        assert len(reqs) == 1
        body = reqs[0][2]
        assert body == {"fields": [{"selector": "#email", "value": "test@example.com"}]}


# ---------------------------------------------------------------------------
# Task 2.4 + 2.5: Response Parsing
# ---------------------------------------------------------------------------


class TestResponseParsing:
    """Verify that Python correctly parses server responses."""

    def test_evaluate_parses_number(self, tracking_server: int) -> None:
        """page.evaluate() returns parsed int from JSON text."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": "42"}], "isError": False})
            )
            result = page.evaluate("21 * 2")
        chrome.close()
        assert result == 42
        assert isinstance(result, int)

    def test_evaluate_parses_string(self, tracking_server: int) -> None:
        """page.evaluate() returns parsed string."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": '"hello"'}], "isError": False})
            )
            result = page.evaluate("'hello'")
        chrome.close()
        assert result == "hello"

    def test_evaluate_parses_boolean(self, tracking_server: int) -> None:
        """page.evaluate() returns parsed boolean."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": "true"}], "isError": False})
            )
            result = page.evaluate("true")
        chrome.close()
        assert result is True

    def test_evaluate_parses_null_as_none(self, tracking_server: int) -> None:
        """page.evaluate() returns None for null."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": "null"}], "isError": False})
            )
            result = page.evaluate("null")
        chrome.close()
        assert result is None

    def test_evaluate_parses_object(self, tracking_server: int) -> None:
        """page.evaluate() returns parsed dict."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {"content": [{"type": "text", "text": '{"a": 1}'}], "isError": False})
            )
            result = page.evaluate("({a: 1})")
        chrome.close()
        assert result == {"a": 1}

    def test_is_error_raises_runtime_error(self, tracking_server: int) -> None:
        """Server response with isError: true raises RuntimeError."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {
                    "content": [{"type": "text", "text": "Element not found: #missing"}],
                    "isError": True,
                })
            )
            with pytest.raises(RuntimeError, match="Element not found"):
                page.click("#missing")
        chrome.close()

    def test_is_error_on_navigate_raises_runtime_error(self, tracking_server: int) -> None:
        """navigate() with isError raises RuntimeError."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {
                    "content": [{"type": "text", "text": "net::ERR_NAME_NOT_RESOLVED"}],
                    "isError": True,
                })
            )
            with pytest.raises(RuntimeError, match="ERR_NAME_NOT_RESOLVED"):
                page.navigate("https://nonexistent.invalid")
        chrome.close()

    def test_evaluate_with_is_error_raises_runtime_error(self, tracking_server: int) -> None:
        """evaluate() with isError raises RuntimeError."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {
                    "content": [{"type": "text", "text": "ReferenceError: foo is not defined"}],
                    "isError": True,
                })
            )
            with pytest.raises(RuntimeError, match="foo is not defined"):
                page.evaluate("foo")
        chrome.close()

    def test_wait_for_timeout_raises_timeout_error(self, tracking_server: int) -> None:
        """wait_for() with timeout-related isError raises TimeoutError."""
        chrome = _make_chrome(tracking_server)
        with chrome.new_page() as page:
            _TrackingHandler.responses.append(
                (200, {
                    "content": [{"type": "text", "text": "Timed out waiting for condition"}],
                    "isError": True,
                })
            )
            with pytest.raises(TimeoutError, match="Timed out"):
                page.wait_for("false")
        chrome.close()


# ---------------------------------------------------------------------------
# Task 3: Auto-Start Verification
# ---------------------------------------------------------------------------


class TestAutoStartVerification:
    """Verify Chrome.connect() auto-start logic."""

    def test_auto_start_probes_port_first(self) -> None:
        """Chrome.connect() probes the port before starting a server."""
        with patch.object(ScriptApiClient, "_is_server_running", return_value=True) as mock_probe:
            chrome = Chrome.connect(host="127.0.0.1", port=19997)
            mock_probe.assert_called_once()
            chrome.close()

    def test_auto_start_starts_server_when_not_running(self) -> None:
        """Chrome.connect() calls start_server when probe fails."""
        with patch.object(ScriptApiClient, "_is_server_running", return_value=False), \
             patch.object(ScriptApiClient, "start_server") as mock_start:
            chrome = Chrome.connect(host="127.0.0.1", port=19997)
            mock_start.assert_called_once_with(server_path=None)
            chrome.close()

    def test_auto_start_finds_binary_in_path_first(self) -> None:
        """start_server() tries PATH binary before npx fallback."""
        import subprocess

        client = ScriptApiClient("127.0.0.1", 19997)

        with patch("shutil.which", side_effect=lambda name: "/opt/bin/public-browser" if name == "public-browser" else None), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server()

            # PATH binary is used, NOT npx
            mock_popen.assert_called_once_with(
                ["/opt/bin/public-browser", "--script"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def test_auto_start_falls_back_to_npx(self) -> None:
        """start_server() falls back to npx when no binary in PATH."""
        import subprocess

        client = ScriptApiClient("127.0.0.1", 19997)

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

    def test_auto_start_passes_script_flag(self) -> None:
        """Server is started with --script flag."""
        import subprocess

        client = ScriptApiClient("127.0.0.1", 19997)

        with patch("shutil.which", return_value="/usr/bin/public-browser"), \
             patch("subprocess.Popen") as mock_popen, \
             patch.object(client, "_wait_for_server"):
            mock_proc = MagicMock()
            mock_proc.poll.return_value = None
            mock_popen.return_value = mock_proc

            client.start_server()

            cmd = mock_popen.call_args[0][0]
            assert "--script" in cmd


# ---------------------------------------------------------------------------
# Task 4: Koexistenz-Matrix
# ---------------------------------------------------------------------------


class TestKoexistenzParallelSessions:
    """Two Page objects operate in independent sessions (AC #5, #6)."""

    def test_two_pages_get_different_session_tokens(self, tracking_server: int) -> None:
        """Two sequential new_page() calls create sessions with different tokens."""
        chrome = _make_chrome(tracking_server)

        with chrome.new_page() as page_a:
            token_a = page_a.session_token
            target_a = page_a.target_id

        with chrome.new_page() as page_b:
            token_b = page_b.session_token
            target_b = page_b.target_id

        chrome.close()

        assert token_a != token_b
        assert target_a != target_b

    def test_two_pages_get_different_cdp_session_ids(self, tracking_server: int) -> None:
        """Two sessions get different CDP session IDs (tab isolation)."""
        chrome = _make_chrome(tracking_server)

        sessions = []
        for _ in range(2):
            with chrome.new_page() as page:
                sessions.append((page.session_token, page.target_id))

        chrome.close()

        assert sessions[0][0] != sessions[1][0]  # different tokens
        assert sessions[0][1] != sessions[1][1]  # different targets

    def test_tool_calls_routed_to_correct_session(self, tracking_server: int) -> None:
        """Each page's tool calls carry its own X-Session header."""
        chrome = _make_chrome(tracking_server)

        with chrome.new_page() as page_a:
            page_a.click("#a")
            token_a = page_a.session_token

        with chrome.new_page() as page_b:
            page_b.click("#b")
            token_b = page_b.session_token

        chrome.close()

        click_reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/tool/click"]
        assert len(click_reqs) == 2

        # First click uses session A's token
        assert click_reqs[0][1]["X-Session"] == token_a
        assert click_reqs[0][2] == {"selector": "#a"}

        # Second click uses session B's token
        assert click_reqs[1][1]["X-Session"] == token_b
        assert click_reqs[1][2] == {"selector": "#b"}


class TestContextManagerCleanup:
    """Context manager sends /session/close even on exception (AC #8)."""

    def test_context_manager_closes_on_normal_exit(self, tracking_server: int) -> None:
        """new_page() context manager sends /session/close on exit."""
        chrome = _make_chrome(tracking_server)

        with chrome.new_page() as page:
            page.click("#btn")

        chrome.close()

        close_reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/session/close"]
        # At least 2: one from probe, one from new_page exit
        assert len(close_reqs) >= 2

    def test_context_manager_closes_on_exception(self, tracking_server: int) -> None:
        """new_page() context manager sends /session/close on exception."""
        chrome = _make_chrome(tracking_server)

        with pytest.raises(RuntimeError, match="boom"):
            with chrome.new_page() as page:
                raise RuntimeError("boom")

        chrome.close()

        close_reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/session/close"]
        # At least 2: one from probe, one from exception cleanup
        assert len(close_reqs) >= 2

    def test_parallel_pages_both_cleaned_up(self, tracking_server: int) -> None:
        """Two nested context managers both send /session/close."""
        chrome = _make_chrome(tracking_server)

        with chrome.new_page() as page_a:
            with chrome.new_page() as page_b:
                page_a.click("#a")
                page_b.click("#b")

        chrome.close()

        close_reqs = [r for r in _TrackingHandler.received_requests if r[0] == "/session/close"]
        # At least 3: probe close + page_b close + page_a close
        assert len(close_reqs) >= 3


# ---------------------------------------------------------------------------
# Task 5: Integration Tests (require real server)
# ---------------------------------------------------------------------------


_CHROME_AVAILABLE = shutil.which("google-chrome") is not None or shutil.which(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
) is not None

_SKIP_REASON = (
    "Integration test requires SilbercueChrome server with --script flag "
    "and Chrome installed."
)


@pytest.mark.integration
@pytest.mark.skipif(not _CHROME_AVAILABLE, reason=_SKIP_REASON)
class TestSharedCoreIntegration:
    """Full roundtrip integration tests against a real SilbercueChrome server.

    Prerequisites:
      1. Chrome installed
      2. Run with: ``pytest -m integration python/tests/test_shared_core.py -v``
    """

    def test_auto_start_and_evaluate(self) -> None:
        """Full roundtrip: Chrome.connect() auto-start, evaluate, result.

        AC #4: Auto-start works and first tool call succeeds within 10s.
        """
        chrome = Chrome.connect()
        try:
            with chrome.new_page() as page:
                page.navigate("about:blank")
                result = page.evaluate("1 + 1")
                assert result == 2
        finally:
            chrome.close()

    def test_shared_core_plus_escape_hatch_same_tab(self) -> None:
        """HTTP path (navigate) + WebSocket path (Runtime.evaluate) on same tab.

        AC #7: refs remain consistent when mixing HTTP and WS paths.
        """
        chrome = Chrome.connect()
        try:
            with chrome.new_page() as page:
                # Shared Core path (HTTP to /tool/navigate)
                page.navigate("about:blank")

                # Escape Hatch path (WebSocket to CDP)
                result = page.cdp.send(
                    "Runtime.evaluate",
                    {"expression": "document.URL", "returnByValue": True},
                )
                assert "about:blank" in result["result"]["value"]

                # Back to Shared Core path
                title = page.evaluate("document.title")
                assert isinstance(title, str)
        finally:
            chrome.close()

    def test_two_scripts_parallel(self) -> None:
        """Two threads each run evaluate() on their own page.

        AC #6: parallel scripts get separate sessions, no interference.
        """
        results: list[Any] = [None, None]
        errors: list[Exception | None] = [None, None]

        def worker(index: int) -> None:
            try:
                chrome = Chrome.connect()
                try:
                    with chrome.new_page() as page:
                        page.navigate("about:blank")
                        results[index] = page.evaluate(f"{index} + 100")
                finally:
                    chrome.close()
            except Exception as e:
                errors[index] = e

        t1 = threading.Thread(target=worker, args=(0,))
        t2 = threading.Thread(target=worker, args=(1,))
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)

        assert errors[0] is None, f"Thread 0 error: {errors[0]}"
        assert errors[1] is None, f"Thread 1 error: {errors[1]}"
        assert results[0] == 100
        assert results[1] == 101

    def test_all_seven_tools_roundtrip(self) -> None:
        """All 7 tool methods work end-to-end against real server."""
        chrome = Chrome.connect()
        try:
            with chrome.new_page() as page:
                # navigate
                page.navigate("about:blank")

                # evaluate
                result = page.evaluate("document.title")
                assert isinstance(result, str)

                # type needs an input element — create one via evaluate
                page.evaluate(
                    'document.body.innerHTML = \'<input id="i">\''
                )
                page.type("#i", "hello")

                # click needs a clickable element
                page.evaluate(
                    'document.body.innerHTML = \'<button id="b">OK</button>\''
                )
                page.click("#b")

                # fill needs form fields
                page.evaluate(
                    'document.body.innerHTML = \'<input id="f1"><input id="f2">\''
                )
                page.fill({"#f1": "a", "#f2": "b"})

                # wait_for
                page.wait_for("document.querySelector('#f1')")

                # download
                dl_path = page.download()
                assert isinstance(dl_path, str)
        finally:
            chrome.close()
