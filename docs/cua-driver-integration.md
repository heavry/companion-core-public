# Cua Driver integration record

- Repository: https://github.com/trycua/cua
- Release: `cua-driver-rs-v0.22.2`
- Upstream commit: `d114f35fec05ecd37bf529e5587be86852205b64`
- License: MIT
- Artifact: `cua-driver-rs-0.22.2-darwin-universal-binary.tar.gz`
- SHA-256: `0bc95dab9543eec416b1c840754eea8bc8a53a7ffcae93dfef7f1825a7938b84`
- Publisher signature: Cua AI, Inc., Team `YCK386LBJ7`

## Chosen integration

Companion installs the pinned universal Cua Driver release into its own Application Support capability directory. The product installer downloads the fixed artifact, enforces a byte limit, verifies SHA-256, rejects archive traversal or undeclared files, verifies the binary version and Developer ID team, then records provenance and health.

The `ComputerUseAdapter` owns a private stdio MCP child using `cua-driver mcp --direct`. On macOS, direct mode deliberately attributes TCC to the invoking host. CompanionMac owns the Core child, and the adapter verifies the actual permission result before claiming readiness. Cua telemetry is disabled in the child environment.

Companion exposes only normalized observe, window, mouse, keyboard, scroll and app actions. Browser DOM work continues to use Playwright. Cua remains a perception/execution backend: the Native Agent is the only planner and multi-step loop.

## Intentionally unused

- Cua Agent/model loop
- Cua Computer History and recording/replay
- Cua browser automation tools
- Cua skills installer and updater
- clipboard, force-kill and unrestricted shell surfaces
- upstream `curl | sh` installer
- the user's separately installed `/Applications/CuaDriver.app`

## Permission ownership

Capability installation and Computer Use actions enter Companion's existing Permission UX. Session grants cover ordinary same-session desktop actions sharing the `computer.use` scope. Dynamic high-risk target descriptions elevate to high risk and external action, so an earlier session grant cannot bypass the hard boundary. macOS Accessibility and Screen Recording remain TCC decisions; Companion only detects, requests and links to System Settings.
