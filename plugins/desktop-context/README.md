# Desktop Context

Desktop Context collects a small, bounded snapshot of the focused Linux
application when dictation starts. It can include:

- focused application name, window title, and window class
- the trailing 3,000 characters from the active WezTerm pane
- the active Emacs file, language, visible text, symbols, and open buffers

Each source defaults to enabled unless its global setting is exactly `"false"`:

- `context_source_window`
- `context_source_terminal`
- `context_source_editor`

The window collector requires the
[Freestyle FocusBridge GNOME extension](../../integrations/gnome-focus-bridge/README.md).
The editor collector additionally requires
[`freestyle-context.el`](../../integrations/emacs/README.md) and a running Emacs
server. WezTerm and Emacs context is collected only while that application is
focused. Missing integrations and collector failures are ignored.

## Development

Build and link the plugin into the local Freestyle plugin directory:

```sh
corepack pnpm --filter @freestyle-voice/plugin-desktop-context link
```

Unlink it with:

```sh
corepack pnpm --filter @freestyle-voice/plugin-desktop-context unlink
```
