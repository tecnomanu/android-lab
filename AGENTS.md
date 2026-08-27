# android-lab for agents

A virtual Android you can drive from a terminal. This file is the contract for
autonomous use: every step is a command, nothing needs a human, and nothing here
opens a prompt you cannot answer.

## Install and boot, non-interactive

```bash
npm i -g android-lab
android-lab setup --yes      # no questions, installs what is missing, then boots
```

`--yes` is what makes it agent-safe: it skips every prompt, takes the defaults,
and installs missing tools it can install without root. Anything that needs root
is printed as an exact command instead of being run behind your back.

Without a TTY (a pipe, CI, a subprocess) the wizard is skipped automatically, so
`android-lab setup` alone behaves the same as `--yes` for prompts — but it still
declines destructive actions rather than guessing. Pass `--yes` explicitly.

One-shot, no global install:

```bash
npx -y android-lab setup --yes
```

## Check before you act

```bash
android-lab doctor           # what can run here and what is missing
android-lab status --json    # machine-readable state
android-lab list --json      # every device, with serials
```

`doctor` is the first call when anything fails. It reports the host's
virtualisation, docker, binder, adb, java and scrcpy, and names the backend it
picked and why. It never changes anything.

## Drive it

```bash
android-lab shell getprop ro.build.version.release   # run and exit
android-lab shell                                     # interactive terminal
android-lab adb -- shell input tap 500 1200           # raw adb, pinned
android-lab screen --shot --out /tmp/now.png          # screenshot, no window
```

`shell` forwards the device's own stdout, stderr and exit code, so it behaves
like any other command in a pipeline. `screen --shot` needs no display and works
headless, which is the one to use when you want to *see* the screen.

## The rule that matters: pin the device

If a real phone is plugged into the same machine, adb sees more than one device.
A bare `adb shell` will either fail with `MULTIPLE_DEVICES` or hit the wrong
phone — someone's actual phone.

This CLI always pins `-s` internally, so every `android-lab` command is safe.
Raw `adb` is not. When you shell out to adb yourself, always pass the serial:

```bash
SERIAL=$(android-lab status --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).serial')
adb -s "$SERIAL" shell whatever
```

`android-lab status` warns you whenever more than one device is visible.

## Several devices

Every command takes `--name`. Ports and serials are allocated and remembered, so
parallel agents do not collide:

```bash
android-lab setup --yes --name agent-a
android-lab setup --yes --name agent-b
android-lab shell --name agent-a "pm list packages"
```

Identity comes from the device name, never the port.

## Clean up after yourself

```bash
android-lab clean --yes                # factory reset, keeps the SDK
android-lab clean --remove --yes       # delete the device, keeps the ~5 GB SDK
android-lab clean --all --yes          # delete everything including the SDK
```

Without `--yes` these refuse to run unattended rather than guessing. Prefer
`--remove` over `--all` unless you really mean to re-download 5 GB.

## Failure modes worth knowing

| Symptom | Cause | Fix |
|---|---|---|
| `Unable to locate a Java Runtime` | macOS ships a `/usr/bin/java` stub that is not a runtime | `brew install openjdk@17`; `doctor` verifies java by running it |
| `MULTIPLE_DEVICES` | a real phone is attached too | use `android-lab`, or pin `-s` yourself |
| adb answers but the UI is not there | the emulator process starts long before Android boots | `start` already waits for `sys.boot_completed`; never treat process start as ready |
| redroid will not start | the host kernel has no binder | Linux only; `sudo modprobe binder_linux devices=binder,hwbinder,vndbinder` |
| `no free emulator console ports` | more than 65 devices, or stale entries | `android-lab list`, then `clean --remove` what you do not need |

## Semantic control with Movicom

Raw adb taps by coordinate are brittle. [Movicom](https://github.com/andycufari/movicom)
drives Android by reading the UI tree, so you can act on elements instead of
pixels. Point it at this device and it never touches a real phone:

```bash
ADB="$(which adb) -s $(android-lab status --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).serial')" \
  node ~/movicom/movicom.js ui frame
```

## With an agent runtime

Works with anything that can run a shell command — [Claude Code](https://claude.com/claude-code),
Codex, OpenCode, Cursor, Aider, Gemini CLI. There is nothing to integrate: the
CLI is the interface.

For [APX](https://github.com/agentprojectcontext/apx), register an MCP pinned to
one device so a delegated agent cannot reach anything else:

```bash
apx mcp add android-emu \
  --command "$(which node)" ~/movicom/mcp/src/server.js \
  --env MOVICOM_BIN=~/movicom/movicom.js \
  --env ADB="$(which adb)" \
  --env MOVICOM_ADB="$(which adb)" \
  --env MOVICOM_DEVICE=emulator-5554
```

Two APX-specific gotchas that cost real time to find:

- The `android_*` tools are **not attached by default**. The agent has to call
  `discover_tools` first, so say so in the prompt.
- `apx send --deliver` and `call_agent` run the target agent **with no tool
  schema** — they are conversational relay. The only path that actually executes
  is `apx exec -a <agent>`.

```bash
apx exec -a <agent> "Load the tools with discover_tools query android.
Then open Settings on the Android and report what you see. Use emulator-5554 only."
```
