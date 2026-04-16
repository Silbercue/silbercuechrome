"""ScriptApiClient — HTTP client for the SilbercueChrome Script API.

Communicates with the SilbercueChrome server via HTTP on Port 9223.
All browser automation logic (selector resolution, Shadow DOM, scroll-into-view,
paint-order filtering, ambient context) runs server-side. This client is a thin
HTTP wrapper that sends tool calls and parses responses.

Usage::

    from silbercuechrome.client import ScriptApiClient

    client = ScriptApiClient("localhost", 9223)
    token, target_id = client.create_session()
    result = client.call_tool("navigate", {"url": "https://example.com"}, token)
    client.close_session(token)
"""

from __future__ import annotations

import atexit
import json
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any


# Default timeouts (seconds)
DEFAULT_TIMEOUT = 30.0
LONG_TIMEOUT = 120.0
SERVER_START_TIMEOUT = 10.0
POLL_INTERVAL = 0.2

# Tools that need longer timeouts
_LONG_TIMEOUT_TOOLS = frozenset({"navigate", "wait_for"})


class ScriptApiClient:
    """HTTP client for the SilbercueChrome Script API on port 9223.

    Handles server auto-start, session management, and tool calls.
    """

    def __init__(self, host: str, port: int) -> None:
        self._host = host
        self._port = port
        self._base_url = f"http://{host}:{port}"
        self._server_proc: subprocess.Popen[bytes] | None = None
        self._closed = False
        self._atexit_registered = False

    @property
    def base_url(self) -> str:
        """The base URL of the Script API server."""
        return self._base_url

    @property
    def closed(self) -> bool:
        """Whether the client has been closed."""
        return self._closed

    # ------------------------------------------------------------------
    # Server lifecycle
    # ------------------------------------------------------------------

    def _is_server_running(self) -> bool:
        """Probe whether the Script API server is reachable."""
        try:
            req = urllib.request.Request(
                f"{self._base_url}/session/create",
                data=b"{}",
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                # Server responded — it's running.
                # We created a session we don't need, close it.
                body = json.loads(resp.read().decode("utf-8"))
                token = body.get("session_token")
                if token:
                    self._close_session_quiet(token)
                return True
        except (urllib.error.URLError, OSError, ValueError):
            return False

    def _close_session_quiet(self, token: str) -> None:
        """Close a session without raising on failure."""
        try:
            self.close_session(token)
        except Exception:
            pass

    def start_server(self, server_path: str | None = None) -> None:
        """Start the SilbercueChrome server as a subprocess.

        Tries in order:
        1. Explicit ``server_path`` if provided
        2. ``silbercuechrome`` in PATH (Homebrew binary)
        3. ``npx -y @silbercue/chrome@latest -- --script`` as fallback

        Args:
            server_path: Explicit path to the server binary.

        Raises:
            FileNotFoundError: If no server binary can be found.
            TimeoutError: If the server does not become ready in time.
        """
        cmd: list[str] | None = None

        if server_path:
            cmd = [server_path, "--script"]
        else:
            # Try silbercuechrome in PATH
            binary = shutil.which("silbercuechrome")
            if binary:
                cmd = [binary, "--script"]
            else:
                # Fallback to npx
                npx = shutil.which("npx")
                if npx:
                    cmd = [npx, "-y", "@silbercue/chrome@latest", "--", "--script"]

        if cmd is None:
            raise FileNotFoundError(
                "Cannot find SilbercueChrome server. Install via "
                "'brew install silbercue/tap/silbercuechrome' or "
                "'npm install -g @silbercue/chrome', or pass server_path= explicitly."
            )

        self._server_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not self._atexit_registered:
            atexit.register(self._shutdown_server)
            self._atexit_registered = True

        # Wait for server to become ready
        self._wait_for_server()

    def _wait_for_server(self, timeout: float = SERVER_START_TIMEOUT) -> None:
        """Poll until the server responds on its port.

        Args:
            timeout: Maximum wait time in seconds.

        Raises:
            TimeoutError: If the server does not respond in time.
        """
        deadline = time.monotonic() + timeout
        health_url = f"{self._base_url}/session/create"
        while time.monotonic() < deadline:
            # Check if server process died
            if self._server_proc and self._server_proc.poll() is not None:
                raise RuntimeError(
                    f"Server process exited with code {self._server_proc.returncode}. "
                    f"Port {self._port} may be in use."
                )
            try:
                req = urllib.request.Request(
                    health_url,
                    data=b"{}",
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=1.0) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                    token = body.get("session_token")
                    if token:
                        self._close_session_quiet(token)
                    return  # Server is ready
            except (urllib.error.URLError, OSError):
                time.sleep(POLL_INTERVAL)

        raise TimeoutError(
            f"Server did not become ready on port {self._port} within {timeout}s. "
            f"Try passing server_path= if the server is not in PATH."
        )

    def _shutdown_server(self) -> None:
        """Terminate the auto-started server process."""
        if self._server_proc and self._server_proc.poll() is None:
            self._server_proc.terminate()
            try:
                self._server_proc.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                self._server_proc.kill()

    # ------------------------------------------------------------------
    # Session management
    # ------------------------------------------------------------------

    def create_session(self) -> tuple[str, str]:
        """Create a new session on the server.

        Returns:
            Tuple of (session_token, target_id).

        Raises:
            RuntimeError: If the server returns an error.
            ConnectionError: If the server is not reachable.
        """
        result = self._post("/session/create", {})
        session_token = result["session_token"]
        target_id = result["target_id"]
        return session_token, target_id

    def close_session(self, session_token: str) -> None:
        """Close a session on the server.

        Args:
            session_token: The session token to close.

        Raises:
            RuntimeError: If the server returns an error.
            ConnectionError: If the server is not reachable.
        """
        self._post(
            "/session/close",
            {"session_token": session_token},
            session_token=session_token,
        )

    # ------------------------------------------------------------------
    # Tool calls
    # ------------------------------------------------------------------

    def call_tool(
        self,
        name: str,
        params: dict[str, Any],
        session_token: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Call a tool on the server.

        Args:
            name: Tool name (e.g. "navigate", "click").
            params: Tool parameters as a dict.
            session_token: Session token for tab routing.
            timeout: Request timeout in seconds. Defaults to LONG_TIMEOUT
                for navigate/wait_for, DEFAULT_TIMEOUT for others.

        Returns:
            The raw server response dict (MCP ToolResponse format).

        Raises:
            RuntimeError: If the server returns an HTTP error.
            ConnectionError: If the server is not reachable.
        """
        if timeout is None:
            timeout = LONG_TIMEOUT if name in _LONG_TIMEOUT_TOOLS else DEFAULT_TIMEOUT

        return self._post(
            f"/tool/{name}",
            params,
            session_token=session_token,
            timeout=timeout,
        )

    # ------------------------------------------------------------------
    # HTTP internals
    # ------------------------------------------------------------------

    def _post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        session_token: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> dict[str, Any]:
        """Send a POST request to the Script API server.

        Args:
            path: URL path (e.g. "/session/create").
            payload: JSON body.
            session_token: Optional session token for X-Session header.
            timeout: Request timeout in seconds.

        Returns:
            Parsed JSON response as dict.

        Raises:
            RuntimeError: On HTTP 4xx/5xx errors.
            ConnectionError: If the server is not reachable.
        """
        url = f"{self._base_url}{path}"
        body = json.dumps(payload).encode("utf-8")

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if session_token:
            headers["X-Session"] = session_token

        req = urllib.request.Request(
            url,
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_body = ""
            try:
                error_body = e.read().decode("utf-8")
            except Exception:
                pass
            raise RuntimeError(
                f"Script API error (HTTP {e.code}): {error_body}"
            ) from e
        except urllib.error.URLError as e:
            raise ConnectionError(
                f"Server not reachable at {url} — was it stopped? ({e.reason})"
            ) from e

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the client and terminate any auto-started server."""
        if self._closed:
            return
        self._closed = True
        self._shutdown_server()

    def __enter__(self) -> ScriptApiClient:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> bool:
        self.close()
        return False
