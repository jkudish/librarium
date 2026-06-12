# librarium README demo tape (charmbracelet/vhs).
#
# Renders the signature live fan-out table. The run is REAL -- the built CLI,
# the real provider adapters, dispatch, dedupe, and summary -- driven by
# art/demo/demo-run.mjs, which stubs ONLY globalThis.fetch so the API calls are
# deterministic and free. The table you see is rendered by librarium itself from
# those canned (but schema-valid) provider responses; nothing here hand-writes
# output. Only the network is mocked; the output format is exactly a real run.
#
# Regenerate:  cd art/demo && bash record.sh
# (record.sh seeds an isolated HOME, then runs: vhs demo.tape)

Output ../demo.gif

Require node

Set Shell "bash"
Set FontSize 14
Set Width 920
Set Height 480
Set Padding 18
Set PlaybackSpeed 1.0
Set TypingSpeed 55ms
Set Theme "Catppuccin Mocha"

# The recorder (record.sh) exports DEMO_HOME and LIBRARIUM_DIR before `vhs`.
Hide
Type "export HOME=$DEMO_HOME FORCE_COLOR=1; clear"
Enter
Show

Sleep 600ms
Type `librarium run "postgres connection pooling best practices"`
Sleep 400ms
Enter

# Hold while the live table fans out and resolves (slowest provider ~3.4s),
# then the dedupe summary prints. Trim trailing hold to keep the GIF small.
Sleep 6s
