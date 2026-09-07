---
name: omp-control-cli
description: Packaged OMP adaptation of cursor-team-kit's control-cli skill. Build or adapt a local harness to drive, inspect, and profile an interactive CLI or TUI without external services. Use for CLI UX checks, startup regressions, memory leaks, hangs, prompt flows, or terminal demos.
---

# Control CLI

> Adapted from `cursor-team-kit/skills/control-cli/SKILL.md` at `cursor/plugins` commit `93b00b89ef425a9c1bac0d0b317dfc49c930ac99` (source SHA-1 `048d2b2f859339a38f0124fecf8648be67eed756`). Cursor-specific tool references are translated to native OMP mechanics; the harness patterns and guardrails are preserved.

Use a repeatable local harness to exercise an interactive CLI instead of poking at it manually. First reuse the repo's own test/demo harness if it exists; otherwise assemble a temporary harness from standard local tools.

## What It Is Used For

- Reproducing CLI/TUI bugs with deterministic input.
- Verifying keyboard flows, prompts, interrupts, resize behavior, and terminal layout.
- Capturing before/after transcripts for bug fixes.
- Profiling startup time, slow operations, hangs, or memory growth.
- Recording a short terminal demo when output is easier to show than explain.

## Harness Loop

1. Identify the command under test and the smallest reproducible workspace.
2. Discover existing local harnesses: package scripts, e2e tests, demo recorders, expect scripts, or PTY helpers.
3. If no harness exists, launch the CLI in an isolated terminal session with deterministic env vars.
4. Capture the current screen before interacting.
5. Send one action at a time: text, Enter, arrows, Escape, Ctrl-C, resize.
6. Wait for a concrete screen pattern or prompt before the next action.
7. Save the transcript and any profile artifacts.
8. Kill the session cleanly.

## Harness Options

- Repo-native harness: prefer checked-in scripts because they know the app's startup, env, and prompts.
- `tmux`: managed sessions, `capture-pane`, `send-keys`, attach/detach.
- PTY probe: use a short Python, Node, or Expect script when tmux is unavailable.
- OMP supervised process: in a live OMP session, start a long-running CLI under process control (`start` with a readiness regex or port) and drive it over stdin; read its output with the log-follow command. This gives deterministic waits without a hand-rolled loop. Keep the session bounded and stop it when done.
- Runtime inspector: use Node or Bun inspector for CPU profiles, heap snapshots, and live evaluation.
- Terminal recorder: use repo-local demo tools or asciinema-compatible tools when the user asks for a demo.

## Minimal tmux Harness

```bash
SESSION="cli-harness-$(date +%s)"
tmux new-session -d -s "$SESSION" -- <command-under-test>
tmux capture-pane -pt "$SESSION"
tmux send-keys -t "$SESSION" "help" Enter
tmux capture-pane -pt "$SESSION"
tmux kill-session -t "$SESSION"
```

For Node CLIs:

```bash
NODE_OPTIONS="--inspect=127.0.0.1:0" tmux new-session -d -s "$SESSION" -- <node-cli-command>
```

Read the terminal output to find the inspector URL, then use Chrome DevTools-compatible tooling if profiling is needed.

## Minimal PTY Harness

Use a PTY script when you need deterministic waits in a repo that does not have tmux or a demo harness. Keep it temporary unless the user asks to add a reusable test.

```python
import os
import pty
import select
import subprocess
import time

master_fd, slave_fd = pty.openpty()
proc = subprocess.Popen(
    ["<command>", "<arg>"],
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    close_fds=True,
)
os.close(slave_fd)

deadline = time.time() + 30
buffer = b""
while time.time() < deadline:
    ready, _, _ = select.select([master_fd], [], [], 0.25)
    if not ready:
        continue
    chunk = os.read(master_fd, 4096)
    buffer += chunk
    if b"<ready text>" in buffer:
        os.write(master_fd, b"help\n")
        break

print(buffer.decode(errors="replace"))
proc.terminate()
os.close(master_fd)
```

If the CLI needs richer terminal control, use `pty.fork()` or an existing PTY library.

## Profiling Recipes

- Startup regression: capture baseline and treatment startup timings under the same machine, env, and command.
- Slow operation: start a CPU profile, perform the operation, stop the profile, and compare top self-time functions.
- Memory leak: force GC if available, take a heap snapshot, perform the operation repeatedly, force GC again, and take another snapshot.
- Hang: capture the screen, active handles/resources, and a stack/CPU sample before interrupting.

## Guardrails

- Prefer deterministic waits over sleeps. If you must sleep, explain why.
- Do not send credentials or destructive commands into a controlled session.
- Keep the harness in `/tmp` unless the repo already has a testing/demo harness.
- Do not hard-code paths from another repository. Adapt commands to the current repo's scripts and runtime.
- Clean up tmux sessions, temp dirs, inspector processes, and demo artifacts unless the user asks to keep them.
