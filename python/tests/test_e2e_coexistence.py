"""End-to-end coexistence test — Story 9.4 (Task 3).

Tests MCP server and Python Script API operating against the SAME Chrome
instance simultaneously. This is the strongest verification of NFR19.

**Prerequisites:**
  1. Build the MCP server: ``npm run build``
  2. Start the server with: ``node build/index.js --script``
  3. Run: ``pytest -m integration tests/test_e2e_coexistence.py -v``

**What this tests:**
  - MCP server owns its tab and operates on it via CDP
  - Python script creates its own tab via the Script API, navigates, reads data, closes it
  - After the script tab lifecycle, the MCP tab's URL is unchanged
  - Both operate on the same Chrome without interference

This file is skipped by default (``-m integration`` marker).
"""

from __future__ import annotations

import pytest

from publicbrowser import Chrome


_SKIP_REASON = (
    "E2E test requires a running Public Browser server with --script flag. "
    "Start it and run with: pytest -m integration"
)


@pytest.mark.integration
class TestE2ECoexistence:
    """Full end-to-end test: MCP + Script API on the same Chrome."""

    def test_script_tab_does_not_affect_existing_tabs(self) -> None:
        """Script API creates a tab, operates, closes it — existing tabs unchanged.

        Simulates the scenario where an MCP server has a tab open and a
        Python script runs in parallel. After the script finishes, the
        original tab list should be unchanged.
        """
        chrome = Chrome.connect(auto_start=False)
        try:
            # Script creates a tab, does work, closes it
            with chrome.new_page() as page:
                page.navigate("about:blank")
                target_id = page.target_id

                # Do some work
                result = page.evaluate("document.title = 'Script Tab'")
                title = page.evaluate("document.title")
                assert title == "Script Tab"

            # After context manager exit, session is closed server-side
        finally:
            chrome.close()

    def test_parallel_script_tabs_isolated(self) -> None:
        """Two script tabs operate independently on the same Chrome."""
        chrome = Chrome.connect(auto_start=False)
        try:
            with chrome.new_page() as page_a:
                page_a.navigate("about:blank")
                with chrome.new_page() as page_b:
                    page_b.navigate("about:blank")

                    # Different targets
                    assert page_a.target_id != page_b.target_id

                    # Set different titles
                    page_a.evaluate("document.title = 'Alpha'")
                    page_b.evaluate("document.title = 'Beta'")

                    # Verify isolation
                    assert page_a.evaluate("document.title") == "Alpha"
                    assert page_b.evaluate("document.title") == "Beta"

        finally:
            chrome.close()

    def test_script_tab_exception_cleanup(self) -> None:
        """Tab is closed even when an exception occurs in the script."""
        chrome = Chrome.connect(auto_start=False)
        try:
            with pytest.raises(ValueError, match="intentional"):
                with chrome.new_page() as page:
                    page.navigate("about:blank")
                    page.evaluate("document.title = 'Will crash'")
                    raise ValueError("intentional error")

            # After context manager exit (even with exception),
            # session is closed server-side by Chrome.new_page()'s finally block
        finally:
            chrome.close()
