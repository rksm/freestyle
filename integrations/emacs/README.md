# Freestyle Emacs context provider

This optional integration gives Freestyle a small, bounded snapshot of the
active Emacs context when dictation starts. It supports Emacs 29 and newer.

## Install

Load the file from your Emacs configuration:

```elisp
(load "/absolute/path/to/freestyle/integrations/emacs/freestyle-context.el")
```

Or load it with `use-package`:

```elisp
(use-package freestyle-context
  :load-path "/absolute/path/to/freestyle/integrations/emacs"
  :demand t)
```

The bridge uses `emacsclient`, so an Emacs server must be running:

```elisp
(require 'server)
(unless (server-running-p)
  (server-start))
```

Freestyle invokes the provider with:

```sh
emacsclient --timeout 1 --eval '(freestyle-context-snapshot)'
```

`freestyle-context-snapshot` returns a JSON string. `emacsclient --eval`
prints that value as an Emacs Lisp string literal, including the surrounding
quotes and escapes. The consumer must therefore decode stdout in exactly two
steps:

1. Read stdout once using Emacs Lisp `read` semantics and assert that the
   result is a string.
2. Parse that string as JSON.

For example, the JSON text `{"language":"typescript"}` is printed by
`emacsclient` as `"{\"language\":\"typescript\"}"`.

Privacy: the snapshot includes visible buffer text and is loaded only when the
user opts in.
