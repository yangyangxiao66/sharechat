# Terminal Matrix integration

Imported runtime source from https://github.com/yangyangxiao66/terminal at
`5828156c9f72492ade132395090357a3c6150214`.

The source repository remains separate. This module is hosted by sharechat's
WebContentsView and uses the dependencies installed in sharechat's root.
Host lifecycle and session-launch IPC are adapted for embedding; renderer
features (PTY matrix, tabs, SSH, skins, character backgrounds and settings)
are retained.

Only tracked runtime files were imported. Local pnpm configuration and
untracked images were not copied. This upstream component is privately owned
code (upstream package declares UNLICENSED), distinct from sharechat's MIT core.
