# Librarium v2 README demo tape (charmbracelet/vhs).
#
# The command runs the built CLI against art/demo/fixture.template.json through
# demo-run.mjs. That fixture replay is network-denied and credential-free.
# Regenerate: cd art/demo && bash record.sh

Output ../demo.gif

Require node

Set Shell "bash"
Set FontSize 15
Set Width 920
Set Height 420
Set Padding 18
Set PlaybackSpeed 1.0
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

Hide
Type "clear"
Enter
Show

Sleep 400ms
Type "librarium live-validation --fixture /absolute/path/to/fixture.json"
Enter
Sleep 2s
