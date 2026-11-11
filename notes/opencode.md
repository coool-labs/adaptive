# opencode-adaptive 1.6.3

Fixes `/adaptive` doing nothing when picked from the slash menu. The command
was registered as taking arguments, and OpenCode only inserts such commands
into the prompt — running them on the prompt-submit key. With keybinds that
send messages on another key (for example submit on Ctrl+Return and Enter for
a newline), picking `/adaptive` never opened the menu. The command now takes
no arguments: picking it from the slash menu opens the menu immediately, like
the GUI.

Typed `/adaptive <subcommand>` forms are gone from the OpenCode TUI; every
action lives in the `/adaptive` menu (Status, Models, Mode, Tier, Pin,
Receipts, Health, Parked work, Doctor). Doctor hints name menu entries
instead of typed subcommands.

The fix is locked in with a real-PTY journey that launches with a custom
keymap (submit on Ctrl+Return, Enter inserting a newline) and asserts the
slash pick opens the menu.
