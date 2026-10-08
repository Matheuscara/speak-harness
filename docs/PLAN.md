# SpeakHarness — product plan

Technical design: [DESIGN.md](DESIGN.md).

## Why

AI coding harnesses (OMP, Pi, Codex, Claude Code…) answer in long markdown. SpeakHarness reads those answers aloud while you keep reading them, so you can:

- **Study a language** — listen and read at the same time, repeat a sentence, slow it down, save phrases.
- **Rest your eyes** — follow a long explanation by ear.
- **Hear it right** — the voice matches the language of each paragraph, and markdown is spoken as structure, never as symbols.

It is local-first: detection, synthesis, and playback run on your machine.

## Decisions

| Topic | Decision |
| --- | --- |
| UI | Terminal UI built with **OpenTUI** (`@opentui/core` + `@opentui/keymap`) |
| Runtime | Bun ≥ 1.3.14 for the app; Node ≥ 22 subprocess for TTS inference |
| Code blocks | **Announced, never read**: "TypeScript code block, 12 lines" |
| Languages (v1) | English and Brazilian Portuguese, detected per paragraph |
| TTS engines (v1) | Interchangeable, local. **Kokoro** for English (`af_heart`); **Piper** for pt-BR (`faber`, pending listening test), Kokoro pt voices as alternatives |
| Config | TOML at `~/.config/speak-harness/config.toml`, editable in the UI |
| License | MIT for SpeakHarness code; the eSpeak-NG phonemizer is GPL-3.0 (see DESIGN.md, Licenses) |

## Ways to use it

### 1. Side panel — `speakh`

Run it next to any harness (tmux split, second terminal). It finds the harness session for the current directory and follows its answers.

```text
┌──────── harness ─────────────────────────────┐┌──────── SpeakHarness ──────────────┐
│ ## What is this task about?                  ││ omp · vitrum · live            ●   │
│ Developers use the **app's database user**…  ││────────────────────────────────────│
│ - **Temporary:** the credential has a TTL    ││ What is this task about?           │
│                                              ││ ▌Developers use the application's  │
│                                              ││ ▌database user to access…          │
│                                              ││ • Temporary: the credential has a  │
│                                              ││   TTL.                             │
│                                              ││────────────────────────────────────│
│                                              ││ ▶ en · af_heart · 1.0× · 2/9  ? keys│
└──────────────────────────────────────────────┘└────────────────────────────────────┘
```

### 2. Wrap mode — `speakh run -- omp`

SpeakHarness starts the harness inside itself (embedded terminal) with a reader panel beside it. A configurable prefix key (default `ctrl+g`) sends commands to SpeakHarness while you keep typing in the harness. This solves keyboard focus and gives a capture path for harnesses without an adapter.

### 3. Headless

- `speakh say answer.md` — read a file or stdin once.
- `speakh follow` — auto-read new answers without UI.
- `speakh ctl <command>` — control a running instance (`speakh ctl replay`) from tmux bindings, shell aliases, or harness extensions.

## Study mode

Toggled with `t`. Built for learning English (or Portuguese) from real answers:

- Sentence by sentence: pause after each sentence; `enter` continues, `r` repeats.
- Repeat slower: `R` replays the current sentence at 0.75×.
- Shadowing: optional silence after each sentence, proportional to its length, so you can repeat it out loud.
- Save phrase: `p` saves the current sentence (with source, language, date) to `~/.local/share/speak-harness/phrases.md`; export to Anki CSV later.
- Visible text always matches what is spoken.

## Reading markdown well

Rules (full table in DESIGN.md):

- Bold, italics, `#`, bullets, and other symbols are never spoken.
- Headings start a new section with a longer pause.
- Lists: one item at a time with a short pause; numbered lists keep their numbers.
- **Code blocks are announced only**: "TypeScript code block, 12 lines", in the language of the surrounding text ("bloco de código TypeScript, 12 linhas").
- Inline code is read as words (`speakLastMessage` → "speak last message"); long inline code is announced as "code".
- Links read their label; bare URLs read the site name; file paths read the file name.
- Tables are summarized ("table with 3 columns: name, type, default"), rows on request.
- Abbreviations come from a per-language pronunciation dictionary the user can extend (`TTL` → "T T L").
- Each paragraph is spoken in its own language's voice.

## Keyboard

Every action is a named command. Keys, the `ctl` CLI, and the command palette all call the same commands, and every key is remappable.

| Command | Default key |
| --- | --- |
| `play-pause` | `space` |
| `stop` | `s` |
| `next-sentence` / `prev-sentence` | `l` / `h` |
| `next-block` / `prev-block` | `L` / `H` |
| `repeat-sentence` / `repeat-slower` | `r` / `R` |
| `replay-message` | `ctrl+r` |
| `next-message` / `prev-message` | `j` / `k` |
| `auto-read` toggle | `a` |
| `study-mode` toggle | `t` |
| `save-phrase` | `p` |
| `voice-auto` / `voice-primary` / `voice-alternate` | `0` / `1` / `2` |
| `speed-up` / `speed-down` | `+` / `-` |
| `switch-session` | `tab` |
| `command-palette` | `:` |
| `settings` / `help` / `quit` | `,` / `?` / `q` |

Multi-key sequences (`g g`) and a leader key are supported through `@opentui/keymap`. Conflicts are reported in the settings screen and on startup.

## Screens

1. **Reader** — rendered answer with the current sentence highlighted; status line with harness, language, voice, speed, position.
2. **Messages** — previous answers of the session; select to read.
3. **Sessions** — detected harness sessions for this directory or all directories.
4. **Settings** — voices, speed, reading rules, languages, keymap editor with conflict warnings.
5. **Help** — cheat sheet generated from the live keymap.
6. **Phrases** — saved study phrases, playable.

## Milestones

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | **Spikes** — OpenTUI markdown highlight, Bun PTY + embedded terminal, engine latency (done: Piper pt-BR ~8× faster than Kokoro) + pt-BR listening test | Each spike answers its question with a runnable script or measurement |
| M1 | **Speech core + `speakh say`** — markdown → speech script, per-paragraph language, Kokoro + Piper engines, voice download, chunked playback | A long mixed EN/PT markdown answer is read naturally, English by Kokoro and Portuguese by Piper, code blocks announced |
| M2 | **Harness adapters + `speakh follow`** — OMP, Codex, Claude Code, Pi | New answers from each harness are spoken when finished; fixture tests per adapter |
| M3 | **Reader TUI** — reader, messages, sessions, status line, highlight | Navigate and read any answer of the current session from the TUI |
| M4 | **Keymap + settings** — config file, settings screen, keymap editor, help | Every command remappable from UI and file; conflicts reported |
| M5 | **Control** — `speakh ctl`, tmux bindings, OMP/Pi extension bridge | Reading triggered from inside the harness |
| M6 | **Study mode** | Sentence-by-sentence, repeat slower, shadowing, saved phrases |
| M7 | **Wrap mode** — `speakh run -- <harness>` | Any harness runs inside SpeakHarness with the prefix key working |
| M8 | **Distribution** — Nix flake, npm, standalone binary | Clean install on NixOS and on a non-Nix Linux |

## Out of scope for v1

- Cloud TTS, cloud language detection, voice cloning.
- Translation (could come later as an optional, explicitly enabled feature).
- Reading tool calls, tool output, or thinking blocks.
- Global OS hotkeys (the `ctl` command covers external triggers).

## Domain

`speakharness.com` had no registration in RDAP when planned. Not purchased.
