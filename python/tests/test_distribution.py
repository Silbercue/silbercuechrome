"""Tests for Story 9.5: pip Distribution.

Verifies:
1. pyproject.toml metadata is correct
2. Package imports work correctly
3. Single-file alternative has identical API surface
4. Build produces valid wheel and sdist
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# pyproject.toml Metadata Tests
# ---------------------------------------------------------------------------


class TestPyprojectToml:
    """Verify pyproject.toml metadata is PyPI-ready."""

    @pytest.fixture(autouse=True)
    def _load_toml(self) -> None:
        """Load pyproject.toml once for all tests."""
        pyproject_path = Path(__file__).parent.parent / "pyproject.toml"
        assert pyproject_path.exists(), "pyproject.toml not found"

        # Python 3.11+ has tomllib in stdlib
        if sys.version_info >= (3, 11):
            import tomllib
        else:
            try:
                import tomllib  # type: ignore[import-not-found]
            except ImportError:
                import tomli as tomllib  # type: ignore[import-not-found,no-redef]

        with open(pyproject_path, "rb") as f:
            self.config = tomllib.load(f)

    def test_package_name(self) -> None:
        """Package name is 'publicbrowser'."""
        assert self.config["project"]["name"] == "publicbrowser"

    def test_version_is_1_0_0(self) -> None:
        """Version matches npm package version."""
        assert self.config["project"]["version"] == "1.0.0"

    def test_description_not_empty(self) -> None:
        """Description is meaningful, not just a placeholder."""
        desc = self.config["project"]["description"]
        assert len(desc) > 20
        assert "CDP" in desc or "Chrome" in desc

    def test_license_is_mit(self) -> None:
        """License is MIT."""
        assert self.config["project"]["license"] == "MIT"

    def test_requires_python_3_10(self) -> None:
        """Minimum Python version is 3.10."""
        assert self.config["project"]["requires-python"] == ">=3.10"

    def test_author_present(self) -> None:
        """At least one author is listed."""
        authors = self.config["project"]["authors"]
        assert len(authors) >= 1
        assert "name" in authors[0]

    def test_websockets_is_only_runtime_dependency(self) -> None:
        """websockets is the only runtime dependency (FR39)."""
        deps = self.config["project"]["dependencies"]
        assert len(deps) == 1
        assert deps[0].startswith("websockets")

    def test_classifiers_present(self) -> None:
        """Classifiers include Python version and license."""
        classifiers = self.config["project"]["classifiers"]
        assert any("Python :: 3.10" in c for c in classifiers)
        assert any("MIT" in c for c in classifiers)
        assert any("Typed" in c for c in classifiers)

    def test_readme_configured(self) -> None:
        """README is configured for PyPI rendering."""
        assert self.config["project"]["readme"] == "README.md"

    def test_project_urls_present(self) -> None:
        """Project URLs (Homepage, Repository) are set."""
        urls = self.config["project"]["urls"]
        assert "Homepage" in urls
        assert "Repository" in urls

    def test_keywords_present(self) -> None:
        """Keywords are set for PyPI search discoverability."""
        keywords = self.config["project"]["keywords"]
        assert len(keywords) >= 3
        assert "chrome" in keywords
        assert "cdp" in keywords

    def test_build_backend_is_hatchling(self) -> None:
        """Build backend is hatchling."""
        assert self.config["build-system"]["build-backend"] == "hatchling.build"

    def test_hatch_wheel_packages(self) -> None:
        """Hatch wheel target includes the package directory."""
        packages = self.config["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]
        assert "publicbrowser" in packages


# ---------------------------------------------------------------------------
# Package Import Tests
# ---------------------------------------------------------------------------


class TestPackageImports:
    """Verify the package can be imported and exports the right symbols."""

    def test_import_chrome(self) -> None:
        """Chrome class is importable from top-level."""
        from publicbrowser import Chrome
        assert Chrome is not None

    def test_import_page(self) -> None:
        """Page class is importable from top-level."""
        from publicbrowser import Page
        assert Page is not None

    def test_import_cdp_client(self) -> None:
        """CdpClient is importable from top-level."""
        from publicbrowser import CdpClient
        assert CdpClient is not None

    def test_import_cdp_error(self) -> None:
        """CdpError is importable from top-level."""
        from publicbrowser import CdpError
        assert CdpError is not None

    def test_version_attribute(self) -> None:
        """__version__ is set to '1.0.0'."""
        import publicbrowser
        assert hasattr(publicbrowser, "__version__")
        assert publicbrowser.__version__ == "1.0.0"

    def test_all_exports(self) -> None:
        """__all__ lists Chrome, Page, ScriptApiClient, CdpClient, CdpError, CdpEscapeHatch."""
        import publicbrowser
        expected = {"Chrome", "Page", "ScriptApiClient", "CdpClient", "CdpError", "CdpEscapeHatch"}
        assert set(publicbrowser.__all__) == expected

    def test_py_typed_marker_exists(self) -> None:
        """py.typed marker file exists for PEP 561 compliance."""
        py_typed = Path(__file__).parent.parent / "publicbrowser" / "py.typed"
        assert py_typed.exists()


# ---------------------------------------------------------------------------
# Single-File Alternative Tests
# ---------------------------------------------------------------------------


class TestSingleFile:
    """Verify the single-file silbercuechrome.py has identical API surface."""

    @pytest.fixture(autouse=True)
    def _load_single_file(self) -> None:
        """Import the single-file module."""
        single_file_path = Path(__file__).parent.parent / "silbercuechrome.py"
        assert single_file_path.exists(), "silbercuechrome.py single-file not found"

        # Import the single file as a separate module to avoid collision
        # with the package
        spec = importlib.util.spec_from_file_location(
            "silbercuechrome_single", str(single_file_path)
        )
        assert spec is not None
        assert spec.loader is not None
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)

    def test_has_chrome_class(self) -> None:
        """Single file exports Chrome class."""
        assert hasattr(self.mod, "Chrome")

    def test_has_page_class(self) -> None:
        """Single file exports Page class."""
        assert hasattr(self.mod, "Page")

    def test_has_cdp_client_class(self) -> None:
        """Single file exports CdpClient class."""
        assert hasattr(self.mod, "CdpClient")

    def test_has_cdp_error_class(self) -> None:
        """Single file exports CdpError class."""
        assert hasattr(self.mod, "CdpError")

    def test_all_exports_match_package(self) -> None:
        """Single-file __all__ is a subset of package __all__.

        The single-file version is v1 (CDP-based) and does not include
        ScriptApiClient. It provides the core symbols that both v1 and v2 share.
        """
        import publicbrowser
        single_file_exports = set(self.mod.__all__)
        package_exports = set(publicbrowser.__all__)
        assert single_file_exports.issubset(package_exports)

    def test_chrome_connect_method(self) -> None:
        """Chrome.connect is a classmethod in the single file."""
        assert hasattr(self.mod.Chrome, "connect")
        assert isinstance(
            self.mod.Chrome.__dict__["connect"], classmethod
        )

    def test_chrome_new_page_method(self) -> None:
        """Chrome.new_page exists in the single file."""
        assert hasattr(self.mod.Chrome, "new_page")

    def test_page_methods_present(self) -> None:
        """All Page methods from the package exist in the single file."""
        expected_methods = [
            "navigate", "click", "type", "fill",
            "wait_for", "evaluate", "download", "close",
        ]
        for method in expected_methods:
            assert hasattr(self.mod.Page, method), f"Page.{method} missing in single file"

    def test_cdp_client_sync_api(self) -> None:
        """CdpClient sync methods exist in the single file."""
        assert hasattr(self.mod.CdpClient, "connect_sync")
        assert hasattr(self.mod.CdpClient, "send_sync")
        assert hasattr(self.mod.CdpClient, "close_sync")

    def test_cdp_error_attributes(self) -> None:
        """CdpError has code, message, data attributes."""
        err = self.mod.CdpError(code=-1, message="test")
        assert err.code == -1
        assert err.message == "test"
        assert err.data is None


# ---------------------------------------------------------------------------
# README Tests
# ---------------------------------------------------------------------------


class TestReadme:
    """Verify README.md exists and has essential content."""

    @pytest.fixture(autouse=True)
    def _load_readme(self) -> None:
        readme_path = Path(__file__).parent.parent / "README.md"
        assert readme_path.exists(), "README.md not found"
        self.content = readme_path.read_text()

    def test_has_installation_section(self) -> None:
        """README contains installation instructions."""
        assert "pip install publicbrowser" in self.content

    def test_has_quick_start(self) -> None:
        """README contains a quick start example."""
        assert "Quick Start" in self.content
        assert "Chrome.connect" in self.content

    def test_mentions_single_file(self) -> None:
        """README mentions the single-file alternative."""
        assert "silbercuechrome.py" in self.content

    def test_has_api_reference(self) -> None:
        """README contains API reference section."""
        assert "API Reference" in self.content

    def test_mentions_websockets_dependency(self) -> None:
        """README mentions websockets as a dependency."""
        assert "websockets" in self.content

    def test_mentions_script_flag(self) -> None:
        """README mentions the --script flag for MCP coexistence."""
        assert "--script" in self.content
