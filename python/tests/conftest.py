"""Shared test fixtures for CDP client tests."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from websockets.exceptions import ConnectionClosed


class FakeWebSocket:
    """In-memory WebSocket mock for unit testing CdpClient.

    Simulates the websockets async iterator protocol that CdpClient._listen() uses.
    """

    def __init__(self) -> None:
        self._sent: list[str] = []
        self._incoming: asyncio.Queue[str | None] = asyncio.Queue()
        self._closed = False

    async def send(self, data: str) -> None:
        """Record sent messages."""
        if self._closed:
            raise ConnectionClosed(None, None)
        self._sent.append(data)

    async def close(self) -> None:
        """Mark as closed and unblock any pending iteration."""
        self._closed = True
        # Sentinel None unblocks __anext__
        self._incoming.put_nowait(None)

    def inject_response(self, msg: dict[str, Any]) -> None:
        """Queue a response to be returned by the async iterator."""
        self._incoming.put_nowait(json.dumps(msg))

    @property
    def sent_messages(self) -> list[dict[str, Any]]:
        """Return all sent messages as parsed dicts."""
        return [json.loads(m) for m in self._sent]

    def __aiter__(self) -> FakeWebSocket:
        return self

    async def __anext__(self) -> str:
        msg = await self._incoming.get()
        if msg is None or self._closed:
            raise StopAsyncIteration
        return msg


@pytest.fixture
def fake_ws() -> FakeWebSocket:
    """Provide a fresh FakeWebSocket instance."""
    return FakeWebSocket()
