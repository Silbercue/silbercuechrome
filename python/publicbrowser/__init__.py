"""Public Browser — Python client for Chrome browser automation.

v2: Uses the Public Browser Script API server (HTTP on port 9223).
All browser automation logic runs server-side for maximum quality.

CdpClient and CdpError are re-exported for backward compatibility
and for the cdp.py escape hatch (Story 9.9).
"""

from publicbrowser.cdp import CdpClient, CdpError
from publicbrowser.chrome import Chrome
from publicbrowser.client import ScriptApiClient
from publicbrowser.escape_hatch import CdpEscapeHatch
from publicbrowser.page import Page

__version__ = "1.0.0"
__all__ = [
    "Chrome",
    "Page",
    "ScriptApiClient",
    "CdpClient",
    "CdpError",
    "CdpEscapeHatch",
]
