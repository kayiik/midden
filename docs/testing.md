# Testing

What each kind of test is for, what stands in for the parts Midden doesn't
own, and when the slow runs are needed. The commands are in
[Development and releases](development.md#test).

## What Midden owns

Midden owns:

- reading recorded sessions, and the output of the `midden` commands (Core);
- the skills' files (the Bundle);
- how the App presents its harness, and how a person works with it there;
- the installers and the releases.

It borrows the rest: the harness and its model (Compa in the App; Copilot
CLI, Claude Code or OpenCode with the Bundle), Pandoc, the harnesses'
session formats and the browser. Tests prove what Midden owns. Borrowed
parts are replaced by stand-ins that follow their published contracts.

The harness drives the model, not Midden. The App only lists a provider's
models and sends one request to check tool calling.

## Three kinds of tests

| Kind | Proves | Runs | Budget |
|---|---|---|---|
| Correctness | Each unit does what its code says. | On every change. | Milliseconds a test. |
| Integration and regression | Midden's parts work together and with each dependency's contract, and what worked keeps working. | On every change. | Seconds a test. |
| Acceptance | Each promise holds as a person meets it, on a built product, in a browser or a terminal. | Against stand-ins on every change; live before a release that touches the promise. | Seconds a scenario. |

## The promises are the acceptance spec

Every claim in the README, on the website and in these docs has acceptance
checks. So does everything the harness can show or ask through the App:
streamed replies, conversations over several turns, tool activity,
approvals, errors, and files it sends. A claim without a check is untested.

## Stand-ins

A stand-in is safe only while it matches the real thing, so each one is
checked against the real dependency. Fake what is slow, costly or
unpredictable; keep what is local and predictable real.

| Dependency | In tests | Checked against the real one |
|---|---|---|
| The model | A scripted OpenAI-compatible server. | Only in live rounds: Midden doesn't depend on what a model says. |
| Compa | The pinned `compa-kernel` itself, with a scripted model. A fake kernel only for states a model can't cause, such as a crash. | Always: CI runs the App's tests with the pinned kernel. |
| Session formats | Synthetic sessions in the format of each supported harness version. | When support for a version is added. |
| Pandoc | Pandoc itself; the rendering tests need 3.1 or later. | The rendering tests with the pinned version, when `PANDOC_VERSION` changes. |
| The browser | Chromium through Playwright. | Chromium, Firefox and WebKit before a release. |

## Supported harness versions

Each release states which versions of Copilot CLI, Claude Code and OpenCode
it supports, as it pins Compa and Pandoc.

- The tests run over synthetic sessions in the format of every supported
  version.
- A newer version is untested until its changes are read and support is
  added, keeping older versions or not.
- Someone on an unsupported version installs the Midden release that
  supports theirs, with `-Version` or `--version`.
- A person's history holds sessions written by several versions, so support
  is stated for the versions that wrote the sessions, and the range says
  where it stops.
- Where a transcript records the version that wrote it, Core says when a
  session comes from a version outside the range.

## When to run what

CI runs the Core, App, release, installer and rendering suites on every push
to `staging` and `main`. Some changes also need:

| Change | Also run |
|---|---|
| `COMPA_VERSION` | A live round of the App's conversations and model setup. |
| `PANDOC_VERSION` | The rendering tests with the new Pandoc, and a live round of presentations and long-form pieces. |
| Support for a harness version | Synthetic sessions in that version's format, added to Core's tests. |
| A skill's text | A live round of that skill, in the App and in a harness with the Bundle. |
| The App's chat or model code | A live round of the App's conversations and model setup. |

## Live rounds

A live round runs the real harness and a real model through the promises a
release touches. Automation drives it and checks what can be measured: the
response format, the tool calls, which skill was read, the files made and
whether they are valid, quotes that pass the quote check, tokens and time. A
person judges the quality of what was made from the run's report, and
records the claims checked, the evidence, the result and the fixes needed.

## Speed and reliability

- Tests run in parallel by default, on fixed seeded data, and never wait on
  real time.
- Under a second per interaction, a few seconds per scenario. The suite's
  wall time is reported, and a slowdown is a defect.
- Every wait has a deadline. A test that times out stops its processes and
  keeps its evidence.
- Nothing waits for a person. A harness prompt that can't be switched off is
  reported to the harness's maker and worked around in the test runner,
  never in Midden.
- One browser while iterating; Chromium, Firefox and WebKit before a
  release.

## UI checks

Start from measurable published rules: WCAG 2.2 AA (contrast, target size,
visible focus, keyboard use, reflow), no clipped or overflowing text at
common viewport sizes, consistent alignment and spacing, and no layout
shift. The thresholds live in one place and are tuned to the design over
time. Screenshots are compared with approved ones, and a person approves a
changed one.

## Where Midden is today

- Correctness and integration: the suites above run in CI. The App's tests
  run the pinned kernel with a scripted model.
- Acceptance: the web tests drive the page with Playwright against a mock
  server, in Chromium only, and take 1 to 5 minutes for 58 tests, depending
  on how busy the machine is
  ([#4](https://github.com/kayiik/midden/issues/4)).
- Harness versions: stated in [Supported versions](core.md#supported-versions),
  from real sessions rather than synthetic ones. Core doesn't yet say when a
  session comes from a version outside them
  ([#1](https://github.com/kayiik/midden/issues/1)).
- Not yet: live rounds and the UI checks above.
