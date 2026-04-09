class Silbercuechrome < Formula
  desc "Fast MCP server for Chrome browser automation via CDP"
  homepage "https://github.com/Silbercue/silbercuechrome"
  url "https://github.com/Silbercue/silbercuechrome/releases/download/v0.0.0/silbercuechrome-pro-v0.0.0-macos-arm64.tar.gz"
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  depends_on arch: :arm64
  depends_on :macos

  def install
    bin.install "silbercuechrome-pro" => "silbercuechrome"
  end

  def caveats
    <<~EOS
      SilbercueChrome launches Google Chrome via the Chrome DevTools Protocol.
      Make sure Google Chrome is installed — auto-launch needs it at runtime.

      To use with Claude Code:
        claude mcp add --scope user silbercuechrome #{opt_bin}/silbercuechrome

      IMPORTANT: After `claude mcp add`, fully quit and reopen Claude Code.
      `/mcp reconnect` is NOT enough — Claude Code caches mcpServers at
      session start and keeps using the old config until a full restart.

      To activate Pro (purchase at https://polar.sh/silbercuechrome):
        silbercuechrome activate <YOUR-LICENSE-KEY>
    EOS
  end

  test do
    assert_match "@silbercuechrome/mcp-pro", shell_output("#{bin}/silbercuechrome version")
  end
end
