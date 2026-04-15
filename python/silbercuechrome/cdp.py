"""Minimal CDP (Chrome DevTools Protocol) client over WebSocket.

This module provides a low-level CDP client that communicates with Chrome
via the DevTools Protocol. It handles:
- WebSocket connection to a Chrome instance
- Request/response matching via message IDs
- CDP event dispatching
- Target discovery via HTTP endpoint
- Session-based routing for tab-specific commands

Usage (async):
    import asyncio
    from silbercuechrome.cdp import CdpClient

    async def main():
        client = await CdpClient.connect("localhost", 9222)
        result = await client.send("Runtime.evaluate", {"expression": "1+1"})
        print(result)  # {"result": {"type": "number", "value": 2}}
        await client.close()

    asyncio.run(main())

Usage (sync):
    from silbercuechrome.cdp import CdpClient

    client = CdpClient.connect_sync("localhost", 9222)
    result = client.send_sync("Runtime.evaluate", {"expression": "1+1"})
    print(result)  # {"result": {"type": "number", "value": 2}}
    client.close_sync()
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import threading
from typing import Any, Callable
from urllib.request import urlopen

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)

# Default timeout for CDP commands (seconds)
DEFAULT_TIMEOUT = 30.0


class CdpError(Exception):
    """Raised when a CDP command returns an error response."""

    def __init__(
        self, code: int, message: str, data: Any = None, method: str | None = None
    ) -> None:
        self.code = code
        self.message = message
        self.data = data
        self.method = method
        if method:
            super().__init__(f"{method} failed: CDP error {code}: {message}")
        else:
            super().__init__(f"CDP error {code}: {message}")


class CdpClient:
    """Minimal async CDP client over WebSocket.

    Handles request/response matching and event dispatching.
    Use `CdpClient.connect()` to create a connected instance.
    """

    def __init__(self, ws_url: str) -> None:
        self._ws_url = ws_url
        self._ws: Any = None
        self._counter = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._event_handlers: dict[str, list[Callable[[dict[str, Any]], None]]] = {}
        self._listener_task: asyncio.Task[None] | None = None
        self._closed = False

    @classmethod
    async def connect(
        cls,
        host: str = "localhost",
        port: int = 9222,
        *,
        target_id: str | None = None,
        ws_url: str | None = None,
    ) -> CdpClient:
        """Connect to a Chrome instance via CDP.

        Args:
            host: Chrome host (default: localhost).
            port: Chrome debugging port (default: 9222).
            target_id: Connect to a specific target (tab). If None, connects
                to the browser-level endpoint.
            ws_url: Direct WebSocket URL. If provided, host/port/target_id
                are ignored.

        Returns:
            A connected CdpClient instance.

        Raises:
            ConnectionError: If Chrome is not reachable.
        """
        if ws_url is None:
            if target_id is not None:
                ws_url = f"ws://{host}:{port}/devtools/page/{target_id}"
            else:
                ws_url = cls._discover_browser_ws(host, port)

        client = cls(ws_url)
        await client._connect()
        return client

    @staticmethod
    def _discover_browser_ws(host: str, port: int) -> str:
        """Discover the browser WebSocket URL via the /json/version endpoint.

        Args:
            host: Chrome host.
            port: Chrome debugging port.

        Returns:
            The browser WebSocket debugger URL.

        Raises:
            ConnectionError: If Chrome is not reachable or the response
                is malformed.
        """
        url = f"http://{host}:{port}/json/version"
        try:
            with urlopen(url, timeout=5) as resp:
                data = json.loads(resp.read())
                ws_url = data.get("webSocketDebuggerUrl")
                if not ws_url:
                    raise ConnectionError(
                        f"No webSocketDebuggerUrl in /json/version response from {url}"
                    )
                return ws_url
        except ConnectionError:
            raise  # Re-raise our own ConnectionError (missing field)
        except OSError as exc:
            raise ConnectionError(
                f"Cannot reach Chrome at {url}. Is Chrome running with "
                f"--remote-debugging-port={port}?"
            ) from exc

    async def _connect(self) -> None:
        """Establish WebSocket connection and start listener."""
        try:
            # websockets.asyncio.client.connect is both an async context manager
            # and directly awaitable. We use __aenter__ to get the connection
            # and store the context manager for clean shutdown.
            self._connect_cm = connect(
                self._ws_url,
                ping_interval=None,  # CDP does not use WebSocket pings
                max_size=64 * 1024 * 1024,  # 64 MB for large DOM snapshots
            )
            self._ws = await self._connect_cm.__aenter__()
        except OSError as exc:
            raise ConnectionError(
                f"WebSocket connection failed to {self._ws_url}: {exc}"
            ) from exc

        self._closed = False
        self._listener_task = asyncio.create_task(self._listen())

    async def _listen(self) -> None:
        """Background listener that dispatches responses and events."""
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("Received non-JSON message: %s", raw[:200])
                    continue

                # Response to a pending request
                if "id" in msg and msg["id"] in self._pending:
                    future = self._pending.pop(msg["id"])
                    if not future.done():
                        future.set_result(msg)
                    continue

                # CDP event (no id, has method)
                method = msg.get("method")
                if method and method in self._event_handlers:
                    params = msg.get("params", {})
                    for handler in self._event_handlers[method]:
                        try:
                            handler(params)
                        except Exception:
                            logger.exception(
                                "Error in event handler for %s", method
                            )
        except ConnectionClosed:
            logger.debug("WebSocket connection closed")
        except asyncio.CancelledError:
            # Map CancelledError to ConnectionError for pending futures
            conn_err = ConnectionError("WebSocket connection lost")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(conn_err)
            self._pending.clear()
            return
        finally:
            # Cancel all pending futures that weren't already resolved
            for future in self._pending.values():
                if not future.done():
                    future.cancel()
            self._pending.clear()

    async def send(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """Send a CDP command and wait for the response.

        Args:
            method: CDP method name (e.g. "Runtime.evaluate").
            params: CDP method parameters.
            timeout: Maximum wait time in seconds.
            session_id: Optional CDP session ID for tab-specific commands.
                When provided, the request includes a ``sessionId`` field
                for multiplexed session routing via Target.attachToTarget.

        Returns:
            The ``result`` field from the CDP response. For example,
            ``Runtime.evaluate`` returns
            ``{"result": {"type": "number", "value": 2}}``.

        Raises:
            CdpError: If CDP returns an error response.
            asyncio.TimeoutError: If the response does not arrive in time.
            ConnectionError: If the WebSocket is not connected.
        """
        if self._closed or self._ws is None:
            raise ConnectionError("CdpClient is not connected")

        cmd_id = next(self._counter)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[cmd_id] = future

        message: dict[str, Any] = {"id": cmd_id, "method": method}
        if params:
            message["params"] = params
        if session_id is not None:
            message["sessionId"] = session_id

        try:
            await self._ws.send(json.dumps(message))
        except ConnectionClosed as exc:
            self._pending.pop(cmd_id, None)
            raise ConnectionError(f"WebSocket closed while sending: {exc}") from exc

        try:
            response = await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(cmd_id, None)
            raise

        if "error" in response:
            err = response["error"]
            raise CdpError(
                code=err.get("code", -1),
                message=err.get("message", "Unknown CDP error"),
                data=err.get("data"),
                method=method,
            )

        return response.get("result", {})

    def on(self, event: str, handler: Callable[[dict[str, Any]], None]) -> None:
        """Register an event handler for a CDP event.

        Args:
            event: CDP event name (e.g. "Page.loadEventFired").
            handler: Callback that receives the event params dict.
        """
        self._event_handlers.setdefault(event, []).append(handler)

    def off(self, event: str, handler: Callable[[dict[str, Any]], None]) -> None:
        """Remove an event handler.

        Args:
            event: CDP event name.
            handler: The handler to remove.
        """
        handlers = self._event_handlers.get(event, [])
        if handler in handlers:
            handlers.remove(handler)

    async def close(self) -> None:
        """Close the WebSocket connection and stop the listener."""
        self._closed = True

        # Cancel all pending futures before stopping the listener
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()

        if self._listener_task and not self._listener_task.done():
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass

        if self._ws:
            await self._ws.close()
            self._ws = None

    # ------------------------------------------------------------------
    # Synchronous API — wraps async methods for non-async callers
    # ------------------------------------------------------------------

    @classmethod
    def connect_sync(
        cls,
        host: str = "localhost",
        port: int = 9222,
        *,
        target_id: str | None = None,
        ws_url: str | None = None,
    ) -> CdpClient:
        """Synchronous version of :meth:`connect`.

        Creates a new event loop in a background thread and connects to Chrome.
        The returned client exposes ``send_sync()`` and ``close_sync()`` for
        purely synchronous usage.

        Args:
            host: Chrome host (default: localhost).
            port: Chrome debugging port (default: 9222).
            target_id: Connect to a specific target (tab).
            ws_url: Direct WebSocket URL (skips discovery).

        Returns:
            A connected CdpClient instance.

        Raises:
            ConnectionError: If Chrome is not reachable.
        """
        loop = asyncio.new_event_loop()
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()

        future = asyncio.run_coroutine_threadsafe(
            cls.connect(host, port, target_id=target_id, ws_url=ws_url), loop
        )
        client = future.result()
        client._sync_loop = loop
        client._sync_thread = thread
        return client

    def send_sync(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """Synchronous version of :meth:`send`.

        Args:
            method: CDP method name (e.g. "Runtime.evaluate").
            params: CDP method parameters.
            timeout: Maximum wait time in seconds.
            session_id: Optional CDP session ID for tab-specific commands.

        Returns:
            The ``result`` field from the CDP response.

        Raises:
            CdpError: If CDP returns an error response.
            TimeoutError: If the response does not arrive in time.
            ConnectionError: If the WebSocket is not connected.
            RuntimeError: If no sync event loop is available (use connect_sync first).
        """
        loop = getattr(self, "_sync_loop", None)
        if loop is None:
            raise RuntimeError(
                "No sync event loop. Use CdpClient.connect_sync() or call send() with await."
            )
        future = asyncio.run_coroutine_threadsafe(
            self.send(method, params, timeout=timeout, session_id=session_id), loop
        )
        return future.result(timeout=timeout + 1)

    def close_sync(self) -> None:
        """Synchronous version of :meth:`close`.

        Closes the WebSocket connection and stops the background event loop.

        Raises:
            RuntimeError: If no sync event loop is available.
        """
        loop = getattr(self, "_sync_loop", None)
        if loop is None:
            raise RuntimeError(
                "No sync event loop. Use CdpClient.connect_sync() or call close() with await."
            )
        future = asyncio.run_coroutine_threadsafe(self.close(), loop)
        future.result(timeout=5)
        loop.call_soon_threadsafe(loop.stop)
        thread = getattr(self, "_sync_thread", None)
        if thread is not None:
            thread.join(timeout=5)

    @property
    def closed(self) -> bool:
        """Whether the client is closed."""
        return self._closed

    async def __aenter__(self) -> CdpClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    def __enter__(self) -> CdpClient:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close_sync()
