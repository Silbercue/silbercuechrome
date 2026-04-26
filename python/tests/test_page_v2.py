"""Tests for Page v2 — Script API based browser tab interaction.

Tests are structured by method:
1. navigate() — URL navigation via /tool/navigate
2. click() — element click via /tool/click
3. type() — text input via /tool/type
4. fill() — multi-field form filling via /tool/fill_form
5. wait_for() — condition polling via /tool/wait_for
6. evaluate() — JavaScript evaluation via /tool/evaluate
7. download() — download setup via /tool/download
8. close() — no-op for v2
"""

from __future__ import annotations

import json
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading
from typing import Any

import pytest

from publicbrowser.client import ScriptApiClient
from publicbrowser.escape_hatch import CdpEscapeHatch
from publicbrowser.page import Page


# ---------------------------------------------------------------------------
# Helper: Fake HTTP server for Page tests
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
            response_body = {"content": [{"type": "text", "text": "ok"}], "isError": False}

        data = json.dumps(response_body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture
def page_with_server():
    """Start a fake server and return a Page wired to it."""
    _FakeHandler.responses = []
    _FakeHandler.received_requests = []

    server = HTTPServer(("127.0.0.1", 0), _FakeHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    client = ScriptApiClient("127.0.0.1", port)
    page = Page(
        client=client,
        session_token="SESSION_TEST",
        target_id="TARGET_TEST",
    )

    yield page

    server.shutdown()
    client.close()


# ---------------------------------------------------------------------------
# navigate() Tests
# ---------------------------------------------------------------------------


class TestPageNavigate:
    """Test Page.navigate() method."""

    def test_navigate_sends_correct_request(self, page_with_server: Page) -> None:
        """navigate() sends POST /tool/navigate with url param."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Navigation complete: https://example.com"}],
                "isError": False,
            }),
        ]

        page_with_server.navigate("https://example.com")

        path, headers, body = _FakeHandler.received_requests[0]
        assert path == "/tool/navigate"
        assert headers["X-Session"] == "SESSION_TEST"
        assert json.loads(body) == {"url": "https://example.com"}

    def test_navigate_returns_none_on_success(self, page_with_server: Page) -> None:
        """navigate() returns None on success."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Navigation complete"}],
                "isError": False,
            }),
        ]

        result = page_with_server.navigate("https://example.com")
        assert result is None

    def test_navigate_raises_on_error(self, page_with_server: Page) -> None:
        """navigate() raises RuntimeError on isError."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "net::ERR_NAME_NOT_RESOLVED"}],
                "isError": True,
            }),
        ]

        with pytest.raises(RuntimeError, match="ERR_NAME_NOT_RESOLVED"):
            page_with_server.navigate("https://nonexistent.invalid")


# ---------------------------------------------------------------------------
# click() Tests
# ---------------------------------------------------------------------------


class TestPageClick:
    """Test Page.click() method."""

    def test_click_sends_correct_request(self, page_with_server: Page) -> None:
        """click() sends POST /tool/click with selector param."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Clicked #submit"}],
                "isError": False,
            }),
        ]

        page_with_server.click("#submit")

        path, headers, body = _FakeHandler.received_requests[0]
        assert path == "/tool/click"
        assert headers["X-Session"] == "SESSION_TEST"
        assert json.loads(body) == {"selector": "#submit"}

    def test_click_accepts_text_selector(self, page_with_server: Page) -> None:
        """click() passes text selectors through to the server."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "Clicked"}], "isError": False}),
        ]

        page_with_server.click("Login")

        _, _, body = _FakeHandler.received_requests[0]
        assert json.loads(body) == {"selector": "Login"}

    def test_click_accepts_ref_selector(self, page_with_server: Page) -> None:
        """click() passes ref selectors through to the server."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "Clicked"}], "isError": False}),
        ]

        page_with_server.click("ref:42")

        _, _, body = _FakeHandler.received_requests[0]
        assert json.loads(body) == {"selector": "ref:42"}

    def test_click_raises_on_error(self, page_with_server: Page) -> None:
        """click() raises RuntimeError when element not found."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Element not found: #missing"}],
                "isError": True,
            }),
        ]

        with pytest.raises(RuntimeError, match="Element not found"):
            page_with_server.click("#missing")


# ---------------------------------------------------------------------------
# type() Tests
# ---------------------------------------------------------------------------


class TestPageType:
    """Test Page.type() method."""

    def test_type_sends_correct_request(self, page_with_server: Page) -> None:
        """type() sends POST /tool/type with selector and text params."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "Typed"}], "isError": False}),
        ]

        page_with_server.type("#input", "Hello World")

        path, headers, body = _FakeHandler.received_requests[0]
        assert path == "/tool/type"
        assert headers["X-Session"] == "SESSION_TEST"
        assert json.loads(body) == {"selector": "#input", "text": "Hello World"}

    def test_type_raises_on_error(self, page_with_server: Page) -> None:
        """type() raises RuntimeError on error."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Element not found: #nope"}],
                "isError": True,
            }),
        ]

        with pytest.raises(RuntimeError, match="Element not found"):
            page_with_server.type("#nope", "text")


# ---------------------------------------------------------------------------
# fill() Tests
# ---------------------------------------------------------------------------


class TestPageFill:
    """Test Page.fill() method."""

    def test_fill_sends_correct_request(self, page_with_server: Page) -> None:
        """fill() sends POST /tool/fill_form with fields array."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "Filled"}], "isError": False}),
        ]

        page_with_server.fill({"#user": "admin", "#pass": "secret"})

        path, headers, body = _FakeHandler.received_requests[0]
        assert path == "/tool/fill_form"
        assert headers["X-Session"] == "SESSION_TEST"

        parsed = json.loads(body)
        assert "fields" in parsed
        fields = parsed["fields"]
        assert len(fields) == 2
        # Check both fields are present (order may vary in older Pythons)
        selectors = {f["selector"] for f in fields}
        values = {f["value"] for f in fields}
        assert selectors == {"#user", "#pass"}
        assert values == {"admin", "secret"}

    def test_fill_raises_on_error(self, page_with_server: Page) -> None:
        """fill() raises RuntimeError on error."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Element not found: #bad"}],
                "isError": True,
            }),
        ]

        with pytest.raises(RuntimeError, match="Element not found"):
            page_with_server.fill({"#bad": "val"})


# ---------------------------------------------------------------------------
# wait_for() Tests
# ---------------------------------------------------------------------------


class TestPageWaitFor:
    """Test Page.wait_for() method."""

    def test_wait_for_sends_correct_request(self, page_with_server: Page) -> None:
        """wait_for() sends POST /tool/wait_for with condition param."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Condition met"}],
                "isError": False,
            }),
        ]

        page_with_server.wait_for("document.querySelector('#done')")

        path, _, body = _FakeHandler.received_requests[0]
        assert path == "/tool/wait_for"
        assert json.loads(body) == {"condition": "js", "expression": "document.querySelector('#done')", "timeout": 120000}

    def test_wait_for_passes_text_shorthand(self, page_with_server: Page) -> None:
        """wait_for('text=Dashboard') passes through to server (server handles shorthand)."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "Condition met"}], "isError": False}),
        ]

        page_with_server.wait_for("text=Dashboard")

        _, _, body = _FakeHandler.received_requests[0]
        assert json.loads(body) == {"condition": "element", "selector": "text/Dashboard", "timeout": 120000}

    def test_wait_for_timeout_raises(self, page_with_server: Page) -> None:
        """wait_for() raises TimeoutError on server-side timeout."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Timed out waiting for condition"}],
                "isError": True,
            }),
        ]

        with pytest.raises(TimeoutError, match="Timed out"):
            page_with_server.wait_for("false")

    def test_wait_for_non_timeout_error_raises_runtime_error(
        self, page_with_server: Page
    ) -> None:
        """wait_for() raises RuntimeError for non-timeout errors."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Evaluation error: syntax error"}],
                "isError": True,
            }),
        ]

        with pytest.raises(RuntimeError, match="syntax error"):
            page_with_server.wait_for("bad{{syntax")


# ---------------------------------------------------------------------------
# evaluate() Tests
# ---------------------------------------------------------------------------


class TestPageEvaluate:
    """Test Page.evaluate() method."""

    def test_evaluate_sends_correct_request(self, page_with_server: Page) -> None:
        """evaluate() sends POST /tool/evaluate with expression param."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "42"}], "isError": False}),
        ]

        page_with_server.evaluate("21 * 2")

        path, _, body = _FakeHandler.received_requests[0]
        assert path == "/tool/evaluate"
        assert json.loads(body) == {"expression": "21 * 2"}

    def test_evaluate_returns_number(self, page_with_server: Page) -> None:
        """evaluate() returns parsed number."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "42"}], "isError": False}),
        ]

        result = page_with_server.evaluate("21 * 2")
        assert result == 42

    def test_evaluate_returns_string(self, page_with_server: Page) -> None:
        """evaluate() returns parsed string."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": '"hello"'}], "isError": False}),
        ]

        result = page_with_server.evaluate("'hello'")
        assert result == "hello"

    def test_evaluate_returns_boolean(self, page_with_server: Page) -> None:
        """evaluate() returns parsed boolean."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "true"}], "isError": False}),
        ]

        result = page_with_server.evaluate("true")
        assert result is True

    def test_evaluate_returns_none_for_null(self, page_with_server: Page) -> None:
        """evaluate() returns None for null."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "null"}], "isError": False}),
        ]

        result = page_with_server.evaluate("null")
        assert result is None

    def test_evaluate_returns_object(self, page_with_server: Page) -> None:
        """evaluate() returns parsed object."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": '{"a": 1, "b": 2}'}],
                "isError": False,
            }),
        ]

        result = page_with_server.evaluate("({a: 1, b: 2})")
        assert result == {"a": 1, "b": 2}

    def test_evaluate_returns_array(self, page_with_server: Page) -> None:
        """evaluate() returns parsed array."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": "[1, 2, 3]"}], "isError": False}),
        ]

        result = page_with_server.evaluate("[1, 2, 3]")
        assert result == [1, 2, 3]

    def test_evaluate_returns_raw_string_on_parse_failure(
        self, page_with_server: Page
    ) -> None:
        """evaluate() returns raw string if JSON parse fails."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Navigation complete: https://example.com"}],
                "isError": False,
            }),
        ]

        result = page_with_server.evaluate("document.title")
        assert result == "Navigation complete: https://example.com"

    def test_evaluate_returns_none_for_empty_response(
        self, page_with_server: Page
    ) -> None:
        """evaluate() returns None for empty content."""
        _FakeHandler.responses = [
            (200, {"content": [{"type": "text", "text": ""}], "isError": False}),
        ]

        result = page_with_server.evaluate("void 0")
        assert result is None

    def test_evaluate_raises_on_error(self, page_with_server: Page) -> None:
        """evaluate() raises RuntimeError on JS error."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "ReferenceError: foo is not defined"}],
                "isError": True,
            }),
        ]

        with pytest.raises(RuntimeError, match="foo is not defined"):
            page_with_server.evaluate("foo")


# ---------------------------------------------------------------------------
# download() Tests
# ---------------------------------------------------------------------------


class TestPageDownload:
    """Test Page.download() method."""

    def test_download_sends_correct_request(self, page_with_server: Page) -> None:
        """download() sends POST /tool/download."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "/tmp/downloads"}],
                "isError": False,
            }),
        ]

        result = page_with_server.download()

        path, _, body = _FakeHandler.received_requests[0]
        assert path == "/tool/download"
        assert json.loads(body) == {}

    def test_download_returns_path(self, page_with_server: Page) -> None:
        """download() returns the download directory path."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "/tmp/silbercuechrome-downloads"}],
                "isError": False,
            }),
        ]

        result = page_with_server.download()
        assert result == "/tmp/silbercuechrome-downloads"

    def test_download_raises_on_error(self, page_with_server: Page) -> None:
        """download() raises RuntimeError on error."""
        _FakeHandler.responses = [
            (200, {
                "content": [{"type": "text", "text": "Download failed"}],
                "isError": True,
            }),
        ]

        with pytest.raises(RuntimeError, match="Download failed"):
            page_with_server.download()


# ---------------------------------------------------------------------------
# close() Tests
# ---------------------------------------------------------------------------


class TestPageClose:
    """Test Page.close() method."""

    def test_close_is_noop(self, page_with_server: Page) -> None:
        """close() is a no-op in v2 — session lifecycle is managed by Chrome."""
        page_with_server.close()
        # No requests should be sent
        assert len(_FakeHandler.received_requests) == 0


# ---------------------------------------------------------------------------
# Page properties
# ---------------------------------------------------------------------------


class TestPageProperties:
    """Test Page property accessors."""

    def test_target_id(self, page_with_server: Page) -> None:
        """target_id returns the CDP target ID."""
        assert page_with_server.target_id == "TARGET_TEST"

    def test_session_token(self, page_with_server: Page) -> None:
        """session_token returns the session token."""
        assert page_with_server.session_token == "SESSION_TEST"


# ---------------------------------------------------------------------------
# page.cdp Escape Hatch Tests (Story 9.9)
# ---------------------------------------------------------------------------


class TestPageCdpProperty:
    """Test Page.cdp property (Escape Hatch)."""

    def test_cdp_property_returns_escape_hatch(self) -> None:
        """page.cdp returns a CdpEscapeHatch instance."""
        client = ScriptApiClient("127.0.0.1", 19999)
        page = Page(
            client=client,
            session_token="TOK",
            target_id="TGT",
            cdp_ws_url="ws://localhost:9222/devtools/page/TGT",
            cdp_session_id="CDP_SESS",
        )
        assert isinstance(page.cdp, CdpEscapeHatch)
        client.close()

    def test_cdp_property_is_same_object_on_repeated_access(self) -> None:
        """page.cdp returns the same instance (lazy singleton)."""
        client = ScriptApiClient("127.0.0.1", 19999)
        page = Page(
            client=client,
            session_token="TOK",
            target_id="TGT",
            cdp_ws_url="ws://localhost:9222/devtools/page/TGT",
            cdp_session_id="CDP_SESS",
        )
        first = page.cdp
        second = page.cdp
        assert first is second
        client.close()

    def test_cdp_property_raises_without_ws_url(self) -> None:
        """page.cdp raises RuntimeError when no cdp_ws_url is available."""
        client = ScriptApiClient("127.0.0.1", 19999)
        page = Page(
            client=client,
            session_token="TOK",
            target_id="TGT",
        )
        with pytest.raises(RuntimeError, match="CDP Escape Hatch not available"):
            _ = page.cdp
        client.close()

    def test_close_clears_escape_hatch(self) -> None:
        """page.close() clears the Escape Hatch reference."""
        client = ScriptApiClient("127.0.0.1", 19999)
        page = Page(
            client=client,
            session_token="TOK",
            target_id="TGT",
            cdp_ws_url="ws://localhost:9222/devtools/page/TGT",
            cdp_session_id="CDP_SESS",
        )
        _ = page.cdp  # Create the escape hatch
        page.close()
        # After close, accessing cdp creates a new instance
        new_hatch = page.cdp
        assert new_hatch is not None
        assert isinstance(new_hatch, CdpEscapeHatch)
        client.close()
