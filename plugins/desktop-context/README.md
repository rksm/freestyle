# Desktop Context

Desktop Context collects a small, bounded snapshot of the focused Linux
application when dictation starts. It can include:

- focused application name, window title, and window class
- the trailing 3,000 characters from the active WezTerm pane
- the active Emacs file, language, visible text, symbols, and open buffers
- up to 2,000 characters of visible Slack accessibility text

Each source defaults to enabled unless its global setting is exactly `"false"`:

- `context_source_window`
- `context_source_terminal`
- `context_source_editor`
- `context_source_accessibility`

The window collector requires the
[Freestyle FocusBridge GNOME extension](../../integrations/gnome-focus-bridge/README.md).
The editor collector additionally requires
[`freestyle-context.el`](../../integrations/emacs/README.md) and a running Emacs
server. WezTerm and Emacs context is collected only while that application is
focused. Slack additionally needs GNOME toolkit accessibility enabled and must
be launched with `GTK_MODULES=gail:atk-bridge` and
`--force-renderer-accessibility`. The collector reads the names of visible
list-item nodes from Slack's AT-SPI Collection API. Missing integrations and
collector failures are ignored.

## Development

Build and link the plugin into the local Freestyle plugin directory:

```sh
corepack pnpm --filter @freestyle-voice/plugin-desktop-context link
```

Unlink it with:

```sh
corepack pnpm --filter @freestyle-voice/plugin-desktop-context unlink
```
