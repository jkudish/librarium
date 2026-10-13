# Offline terminal tests

`npm run test:pty` builds the CLI and drives it in a real pseudo-terminal.
The tests exercise `research` progress, Ctrl-C detachment and `show` recovery,
and `setup`'s masked credential prompt and saved v3 config. Every test uses an
isolated HOME. The fixture replaces fetch responses and denies network sockets;
no provider is contacted. Native node-pty is required; Windows skips this lane.

The harness supplies `waitForText`, keystrokes, SIGINT and bounded exit waits.
Assert observable landmarks and saved Runs rather than terminal row positions.
