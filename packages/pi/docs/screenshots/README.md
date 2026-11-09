# Pi terminal screens

Real Pi 1.5.0 TUI frames at 80 columns, captured by the packed-extension PTY journeys
(`test/tui/journeys.spec.ts`). They are plain text (Termwright's screen snapshot), not
mock-ups. Regenerate them with:

```sh
ADAPTIVE_PI_SCREENSHOTS="$PWD/packages/pi/docs/screenshots" npm run e2e:tui -w packages/pi
```

The run also keeps every frame it checks, at 60×24, 80×24 and 120×40, under
`test-artifacts/pi-matrix/<run>/screens/`.

| File                                  | Screen                                                          |
| ------------------------------------- | --------------------------------------------------------------- |
| `first-run-proposal-80x24.txt`        | First-run tier proposal (nothing saved yet)                     |
| `routed-note-80x24.txt`               | First routed turn and its dim `Adaptive · …` note               |
| `parked-card-80x24.txt`               | All-down parked card and footer status chip                     |
| `doctor-80x24.txt`                    | `/adaptive` doctor, everything healthy                          |
| `doctor-missing-credential-80x24.txt` | Doctor with a tier model missing credentials: the problem leads |
