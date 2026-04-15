"""Tests for Page — browser tab interaction methods.

Tests are structured by method:
1. navigate() — URL navigation with readyState polling
2. click() — element click via coordinates
3. type() — text input via key events
4. fill() — multi-field form filling
5. wait_for() — condition polling
6. evaluate() — JavaScript evaluation
7. download() — download setup
8. close() — tab lifecycle
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any
from unittest.mock import patch

import pytest

from silbercuechrome.cdp import CdpClient
from silbercuechrome.page import Page, _DOWNLOAD_DIR
from tests.conftest import FakeWebSocket


# ---------------------------------------------------------------------------
# Helper: create a Page with a FakeWebSocket-backed CdpClient
# ---------------------------------------------------------------------------


class _FakeConnectCtx:
    """Async context manager that returns a FakeWebSocket."""

    def __init__(self, ws: FakeWebSocket) -> None:
        self._ws = ws

    async def __aenter__(self) -> FakeWebSocket:
        return self._ws

    async def __aexit__(self, *exc: Any) -> None:
        pass


def make_page(fake_ws: FakeWebSocket) -> tuple[Page, CdpClient]:
    """Create a Page with a FakeWebSocket-backed CdpClient.

    Returns (page, browser_client) tuple.
    """
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
        client = CdpClient.connect_sync(port=9222)

    page = Page(
        browser_client=client,
        session_id="SESSION_TEST",
        target_id="TARGET_TEST",
    )
    return page, client


def inject_from_thread(
    fake_ws: FakeWebSocket,
    loop: Any,
    messages: list[dict[str, Any]],
    delay: float = 0.03,
) -> None:
    """Inject responses from a background thread."""

    def _inject() -> None:
        for msg in messages:
            time.sleep(delay)
            loop.call_soon_threadsafe(
                fake_ws._incoming.put_nowait,
                json.dumps(msg),
            )

    threading.Thread(target=_inject, daemon=True).start()


# ---------------------------------------------------------------------------
# navigate() Tests
# ---------------------------------------------------------------------------


class TestPageNavigate:
    """Test Page.navigate() method."""

    def test_navigate_sends_correct_commands(self, fake_ws: FakeWebSocket) -> None:
        """navigate() sends Page.navigate and polls readyState."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        # Response sequence:
        # 1. Page.navigate result
        # 2. Runtime.evaluate (readyState) -> "complete"
        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"frameId": "FRAME_1", "loaderId": "LOADER_1"}},
            {
                "id": 2,
                "result": {
                    "result": {"type": "string", "value": "complete"},
                },
            },
        ])

        result = page.navigate("https://example.com", timeout=5.0)

        assert result["frameId"] == "FRAME_1"
        assert result["loaderId"] == "LOADER_1"

        sent = fake_ws.sent_messages
        assert sent[0]["method"] == "Page.navigate"
        assert sent[0]["params"]["url"] == "https://example.com"
        assert sent[0]["sessionId"] == "SESSION_TEST"

        # Second message should be Runtime.evaluate for readyState
        assert sent[1]["method"] == "Runtime.evaluate"
        assert "readyState" in sent[1]["params"]["expression"]

        client.close_sync()

    def test_navigate_polls_until_complete(self, fake_ws: FakeWebSocket) -> None:
        """navigate() polls readyState multiple times until 'complete'."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        # We need to inject responses on-demand as the page polls readyState.
        # Use a counter to track which poll we're on and respond accordingly.
        poll_count = 0
        responses = ["loading", "interactive", "complete"]

        def inject_on_demand() -> None:
            nonlocal poll_count
            # First inject the Page.navigate response
            time.sleep(0.03)
            loop.call_soon_threadsafe(
                fake_ws._incoming.put_nowait,
                json.dumps({"id": 1, "result": {"frameId": "F1"}}),
            )
            # Then inject readyState responses with enough delay for polling
            for i, state in enumerate(responses):
                time.sleep(0.15)  # Wait for the poll interval + processing
                loop.call_soon_threadsafe(
                    fake_ws._incoming.put_nowait,
                    json.dumps({
                        "id": i + 2,
                        "result": {"result": {"type": "string", "value": state}},
                    }),
                )

        threading.Thread(target=inject_on_demand, daemon=True).start()

        result = page.navigate("https://slow.com", timeout=5.0)
        assert result["frameId"] == "F1"

        # Should have sent multiple readyState polls
        sent = fake_ws.sent_messages
        evaluate_calls = [m for m in sent if m["method"] == "Runtime.evaluate"]
        assert len(evaluate_calls) >= 2  # At least loading + complete

        client.close_sync()

    def test_navigate_error_raises_runtime_error(self, fake_ws: FakeWebSocket) -> None:
        """navigate() raises RuntimeError if Page.navigate returns errorText."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"errorText": "net::ERR_NAME_NOT_RESOLVED"}},
        ])

        with pytest.raises(RuntimeError, match="net::ERR_NAME_NOT_RESOLVED"):
            page.navigate("https://nonexistent.invalid", timeout=5.0)

        client.close_sync()


# ---------------------------------------------------------------------------
# click() Tests
# ---------------------------------------------------------------------------


class TestPageClick:
    """Test Page.click() method."""

    def test_click_sends_mouse_events(self, fake_ws: FakeWebSocket) -> None:
        """click() evaluates querySelector, then sends mousePressed + mouseReleased."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            # Runtime.evaluate (querySelector + getBoundingClientRect)
            {"id": 1, "result": {"result": {"type": "object", "value": {"x": 100, "y": 200}}}},
            # Input.dispatchMouseEvent (mousePressed)
            {"id": 2, "result": {}},
            # Input.dispatchMouseEvent (mouseReleased)
            {"id": 3, "result": {}},
        ])

        page.click("#submit", timeout=5.0)

        sent = fake_ws.sent_messages
        assert sent[0]["method"] == "Runtime.evaluate"

        # mousePressed
        assert sent[1]["method"] == "Input.dispatchMouseEvent"
        assert sent[1]["params"]["type"] == "mousePressed"
        assert sent[1]["params"]["x"] == 100
        assert sent[1]["params"]["y"] == 200
        assert sent[1]["params"]["button"] == "left"
        assert sent[1]["params"]["clickCount"] == 1

        # mouseReleased
        assert sent[2]["method"] == "Input.dispatchMouseEvent"
        assert sent[2]["params"]["type"] == "mouseReleased"
        assert sent[2]["params"]["x"] == 100
        assert sent[2]["params"]["y"] == 200

        client.close_sync()

    def test_click_element_not_found_raises(self, fake_ws: FakeWebSocket) -> None:
        """click() raises RuntimeError if the element is not found."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "object", "value": {"error": "Element not found: #missing"}}}},
        ])

        with pytest.raises(RuntimeError, match="Element not found"):
            page.click("#missing", timeout=5.0)

        client.close_sync()

    def test_click_zero_size_raises(self, fake_ws: FakeWebSocket) -> None:
        """click() raises RuntimeError if the element has zero dimensions."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "object", "value": {"error": "Element has zero size: #hidden"}}}},
        ])

        with pytest.raises(RuntimeError, match="zero size"):
            page.click("#hidden", timeout=5.0)

        client.close_sync()


# ---------------------------------------------------------------------------
# type() Tests
# ---------------------------------------------------------------------------


class TestPageType:
    """Test Page.type() method."""

    def test_type_sends_key_events_per_character(self, fake_ws: FakeWebSocket) -> None:
        """type() focuses element then sends keyDown/keyUp for each char."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        # Response for focus + 2 chars * 2 events = 5 total
        inject_from_thread(fake_ws, loop, [
            # focus
            {"id": 1, "result": {"result": {"type": "object", "value": {"ok": True}}}},
            # 'H' keyDown
            {"id": 2, "result": {}},
            # 'H' keyUp
            {"id": 3, "result": {}},
            # 'i' keyDown
            {"id": 4, "result": {}},
            # 'i' keyUp
            {"id": 5, "result": {}},
        ])

        page.type("#input", "Hi", timeout=5.0)

        sent = fake_ws.sent_messages
        # First: focus via evaluate
        assert sent[0]["method"] == "Runtime.evaluate"

        # Then key events
        assert sent[1]["method"] == "Input.dispatchKeyEvent"
        assert sent[1]["params"]["type"] == "keyDown"
        assert sent[1]["params"]["text"] == "H"

        assert sent[2]["method"] == "Input.dispatchKeyEvent"
        assert sent[2]["params"]["type"] == "keyUp"
        assert sent[2]["params"]["key"] == "H"

        assert sent[3]["method"] == "Input.dispatchKeyEvent"
        assert sent[3]["params"]["text"] == "i"

        assert sent[4]["method"] == "Input.dispatchKeyEvent"
        assert sent[4]["params"]["type"] == "keyUp"

        client.close_sync()

    def test_type_element_not_found_raises(self, fake_ws: FakeWebSocket) -> None:
        """type() raises RuntimeError if the input element is not found."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "object", "value": {"error": "Element not found: #nope"}}}},
        ])

        with pytest.raises(RuntimeError, match="Element not found"):
            page.type("#nope", "text", timeout=5.0)

        client.close_sync()


# ---------------------------------------------------------------------------
# fill() Tests
# ---------------------------------------------------------------------------


class TestPageFill:
    """Test Page.fill() method."""

    def test_fill_clears_and_types_each_field(self, fake_ws: FakeWebSocket) -> None:
        """fill() clears each field then types the value character by character."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        # For one field "#user" with value "ab":
        # 1. evaluate (clear + focus)
        # 2. keyDown 'a'
        # 3. keyUp 'a'
        # 4. keyDown 'b'
        # 5. keyUp 'b'
        inject_from_thread(fake_ws, loop, [
            # clear #user
            {"id": 1, "result": {"result": {"type": "object", "value": {"ok": True}}}},
            # 'a' keyDown
            {"id": 2, "result": {}},
            # 'a' keyUp
            {"id": 3, "result": {}},
            # 'b' keyDown
            {"id": 4, "result": {}},
            # 'b' keyUp
            {"id": 5, "result": {}},
        ])

        page.fill({"#user": "ab"}, timeout=5.0)

        sent = fake_ws.sent_messages
        # First: clear via evaluate (includes focus + value = '')
        assert sent[0]["method"] == "Runtime.evaluate"
        assert "value" in sent[0]["params"]["expression"]  # sets value to ''

        # Then key events
        assert sent[1]["params"]["text"] == "a"
        assert sent[3]["params"]["text"] == "b"

        client.close_sync()

    def test_fill_multiple_fields(self, fake_ws: FakeWebSocket) -> None:
        """fill() processes multiple fields in order."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        # 2 fields, single char each: 2 * (1 clear + 2 key events) = 6 messages
        inject_from_thread(fake_ws, loop, [
            # clear #user
            {"id": 1, "result": {"result": {"type": "object", "value": {"ok": True}}}},
            # 'a' keyDown
            {"id": 2, "result": {}},
            # 'a' keyUp
            {"id": 3, "result": {}},
            # clear #pass
            {"id": 4, "result": {"result": {"type": "object", "value": {"ok": True}}}},
            # 'x' keyDown
            {"id": 5, "result": {}},
            # 'x' keyUp
            {"id": 6, "result": {}},
        ])

        page.fill({"#user": "a", "#pass": "x"}, timeout=5.0)

        sent = fake_ws.sent_messages
        # Two evaluate calls (one per field)
        evaluates = [m for m in sent if m["method"] == "Runtime.evaluate"]
        assert len(evaluates) == 2

        client.close_sync()

    def test_fill_element_not_found_raises(self, fake_ws: FakeWebSocket) -> None:
        """fill() raises RuntimeError if any field element is not found."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "object", "value": {"error": "Element not found: #bad"}}}},
        ])

        with pytest.raises(RuntimeError, match="Element not found"):
            page.fill({"#bad": "val"}, timeout=5.0)

        client.close_sync()


# ---------------------------------------------------------------------------
# wait_for() Tests
# ---------------------------------------------------------------------------


class TestPageWaitFor:
    """Test Page.wait_for() method."""

    def test_wait_for_returns_truthy_value(self, fake_ws: FakeWebSocket) -> None:
        """wait_for() returns the truthy evaluation result."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        # Inject responses on-demand with enough delay for polling cycle
        def inject_responses() -> None:
            # First poll: falsy
            time.sleep(0.03)
            loop.call_soon_threadsafe(
                fake_ws._incoming.put_nowait,
                json.dumps({"id": 1, "result": {"result": {"type": "boolean", "value": False}}}),
            )
            # Second poll: truthy (wait for poll_interval + processing)
            time.sleep(0.2)
            loop.call_soon_threadsafe(
                fake_ws._incoming.put_nowait,
                json.dumps({"id": 2, "result": {"result": {"type": "string", "value": "found"}}}),
            )

        threading.Thread(target=inject_responses, daemon=True).start()

        result = page.wait_for("document.querySelector('#done')", timeout=5.0)
        assert result == "found"

        client.close_sync()

    def test_wait_for_text_shorthand(self, fake_ws: FakeWebSocket) -> None:
        """wait_for('text=Dashboard') translates to innerText.includes check."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "boolean", "value": True}}},
        ])

        result = page.wait_for("text=Dashboard", timeout=5.0)
        assert result is True

        sent = fake_ws.sent_messages
        expr = sent[0]["params"]["expression"]
        assert "document.body.innerText.includes" in expr
        assert '"Dashboard"' in expr

        client.close_sync()

    def test_wait_for_text_shorthand_with_special_chars(self, fake_ws: FakeWebSocket) -> None:
        """text= shorthand correctly escapes special characters."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "boolean", "value": True}}},
        ])

        result = page.wait_for('text=Hello "World"', timeout=5.0)
        assert result is True

        sent = fake_ws.sent_messages
        expr = sent[0]["params"]["expression"]
        assert "document.body.innerText.includes" in expr
        # json.dumps escapes the quotes properly
        assert 'Hello \\"World\\"' in expr

        client.close_sync()

    def test_wait_for_timeout_raises(self, fake_ws: FakeWebSocket) -> None:
        """wait_for() raises TimeoutError if condition stays falsy."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        # Keep returning falsy — inject responses as they are requested
        def inject_falsy() -> None:
            for i in range(50):
                time.sleep(0.06)  # Enough delay for poll_interval + processing
                loop.call_soon_threadsafe(
                    fake_ws._incoming.put_nowait,
                    json.dumps({"id": i + 1, "result": {"result": {"type": "boolean", "value": False}}}),
                )

        threading.Thread(target=inject_falsy, daemon=True).start()

        with pytest.raises(TimeoutError, match="Condition not met"):
            page.wait_for("false", timeout=0.5, poll_interval=0.05)

        client.close_sync()


# ---------------------------------------------------------------------------
# evaluate() Tests
# ---------------------------------------------------------------------------


class TestPageEvaluate:
    """Test Page.evaluate() method."""

    def test_evaluate_returns_value(self, fake_ws: FakeWebSocket) -> None:
        """evaluate() returns the evaluated JavaScript value."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "number", "value": 42}}},
        ])

        result = page.evaluate("21 * 2", timeout=5.0)
        assert result == 42

        client.close_sync()

    def test_evaluate_returns_string(self, fake_ws: FakeWebSocket) -> None:
        """evaluate() returns string values."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "string", "value": "hello"}}},
        ])

        result = page.evaluate("'hello'", timeout=5.0)
        assert result == "hello"

        client.close_sync()

    def test_evaluate_returns_none_for_undefined(self, fake_ws: FakeWebSocket) -> None:
        """evaluate() returns None for undefined results."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "undefined"}}},
        ])

        result = page.evaluate("void 0", timeout=5.0)
        assert result is None

        client.close_sync()

    def test_evaluate_returns_object(self, fake_ws: FakeWebSocket) -> None:
        """evaluate() returns objects by value."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "object", "value": {"a": 1, "b": 2}}}},
        ])

        result = page.evaluate("({a: 1, b: 2})", timeout=5.0)
        assert result == {"a": 1, "b": 2}

        client.close_sync()

    def test_evaluate_returns_boolean(self, fake_ws: FakeWebSocket) -> None:
        """evaluate() returns boolean values."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "boolean", "value": True}}},
        ])

        result = page.evaluate("true", timeout=5.0)
        assert result is True

        client.close_sync()

    def test_evaluate_js_error_raises(self, fake_ws: FakeWebSocket) -> None:
        """evaluate() raises RuntimeError on JavaScript exceptions."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {
                "id": 1,
                "result": {
                    "result": {"type": "object"},
                    "exceptionDetails": {
                        "text": "Uncaught",
                        "exception": {
                            "description": "ReferenceError: foo is not defined",
                        },
                    },
                },
            },
        ])

        with pytest.raises(RuntimeError, match="foo is not defined"):
            page.evaluate("foo", timeout=5.0)

        client.close_sync()

    def test_evaluate_sends_return_by_value(self, fake_ws: FakeWebSocket) -> None:
        """evaluate() always sets returnByValue: true."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "number", "value": 1}}},
        ])

        page.evaluate("1", timeout=5.0)

        sent = fake_ws.sent_messages
        assert sent[0]["params"]["returnByValue"] is True

        client.close_sync()

    def test_evaluate_await_promise(self, fake_ws: FakeWebSocket) -> None:
        """evaluate() with await_promise=True sends awaitPromise param."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"result": {"type": "number", "value": 99}}},
        ])

        result = page.evaluate(
            "Promise.resolve(99)", timeout=5.0, await_promise=True
        )
        assert result == 99

        sent = fake_ws.sent_messages
        assert sent[0]["params"]["awaitPromise"] is True

        client.close_sync()


# ---------------------------------------------------------------------------
# download() Tests
# ---------------------------------------------------------------------------


class TestPageDownload:
    """Test Page.download() method."""

    def test_download_enables_downloads(self, fake_ws: FakeWebSocket) -> None:
        """download() sends Browser.setDownloadBehavior."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {}},
        ])

        path = page.download(download_path="/tmp/test-downloads", timeout=5.0)
        assert path == "/tmp/test-downloads"

        sent = fake_ws.sent_messages
        assert sent[0]["method"] == "Browser.setDownloadBehavior"
        assert sent[0]["params"]["behavior"] == "allowAndName"
        assert sent[0]["params"]["downloadPath"] == "/tmp/test-downloads"
        assert sent[0]["params"]["eventsEnabled"] is True
        # Browser-level command: no sessionId
        assert "sessionId" not in sent[0]

        client.close_sync()

    def test_download_uses_default_dir(self, fake_ws: FakeWebSocket) -> None:
        """download() without path uses the default temp directory."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {}},
        ])

        path = page.download(timeout=5.0)
        assert path == _DOWNLOAD_DIR
        assert "silbercuechrome-downloads" in path

        client.close_sync()


# ---------------------------------------------------------------------------
# close() Tests
# ---------------------------------------------------------------------------


class TestPageClose:
    """Test Page.close() method."""

    def test_close_sends_close_target(self, fake_ws: FakeWebSocket) -> None:
        """close() sends Target.closeTarget with the correct targetId."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"success": True}},
        ])

        page.close()

        assert page.closed
        sent = fake_ws.sent_messages
        assert sent[0]["method"] == "Target.closeTarget"
        assert sent[0]["params"]["targetId"] == "TARGET_TEST"

        client.close_sync()

    def test_double_close_is_safe(self, fake_ws: FakeWebSocket) -> None:
        """Calling close() twice does not raise or send duplicate commands."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "result": {"success": True}},
        ])

        page.close()
        page.close()  # Should not raise

        sent = fake_ws.sent_messages
        close_calls = [m for m in sent if m["method"] == "Target.closeTarget"]
        assert len(close_calls) == 1

        client.close_sync()

    def test_close_handles_already_gone_tab(self, fake_ws: FakeWebSocket) -> None:
        """close() does not raise if the tab is already gone (CDP error)."""
        page, client = make_page(fake_ws)
        loop = client._sync_loop

        inject_from_thread(fake_ws, loop, [
            {"id": 1, "error": {"code": -32000, "message": "No target with given id found"}},
        ])

        # Should not raise
        page.close()
        assert page.closed

        client.close_sync()


# ---------------------------------------------------------------------------
# Page properties
# ---------------------------------------------------------------------------


class TestPageProperties:
    """Test Page property accessors."""

    def test_target_id(self, fake_ws: FakeWebSocket) -> None:
        """target_id returns the CDP target ID."""
        page, client = make_page(fake_ws)
        assert page.target_id == "TARGET_TEST"
        client.close_sync()

    def test_closed_initially_false(self, fake_ws: FakeWebSocket) -> None:
        """A new Page is not closed."""
        page, client = make_page(fake_ws)
        assert not page.closed
        client.close_sync()
