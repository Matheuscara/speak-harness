# SpeakHarness

Local-first speech for AI coding harnesses.

## Vision

Read assistant responses aloud with a voice that matches the response language, while keeping the transcript visible. Work across coding harnesses instead of binding the speech engine to one agent or terminal UI.

## Product direction

- Detect English and Brazilian Portuguese locally; use language-specific voices and phonemization.
- Keep the selected text visible while listening; replay the last response and choose an explicit voice when desired.
- Support long responses incrementally so synthesis does not block the harness UI.
- Run speech synthesis and audio playback locally by default. No response text leaves the machine for language detection or voice generation.
- Let each harness adapter preserve its native interaction model and keyboard shortcuts.

## Proposed architecture

1. **Speech core** — normalized requests, local language detection, voice/language metadata, TTS engine interface, chunked synthesis, cancellation, and playback queue.
2. **Harness adapters** — thin integrations that pass assistant text and user settings to the core. Start with an OMP/Pi adapter; add others behind the same core contract.
3. **Host runtime** — platform-aware audio output and model/runtime management. Keep OS-specific dependencies out of harness adapters.
4. **User controls** — a small settings surface for automatic language selection, voice overrides, speed, replay, and interruption.

## First milestone

A working local flow for English and pt-BR: read the latest assistant response, detect its language, synthesize the matching voice in ordered chunks, play it without freezing the TUI, and retain a manual replay/voice override. Validate it in OMP before adding another harness adapter.

## Explicit non-goals for the first milestone

- Cloud speech or cloud language detection.
- Voice cloning.
- Supporting every harness before the core contract has been exercised by a second adapter.
- Replacing each harness's own transcript or terminal UI.

## Repository status

Planning repository. See [docs/PLAN.md](docs/PLAN.md) for the product plan (usage modes, study mode, markdown reading, keymap, milestones) and [docs/DESIGN.md](docs/DESIGN.md) for the technical design (adapters, speech script, language detection, engine protocol, OpenTUI composition). The existing `pi-speak` work informed this direction; implementation has not been copied into this repository yet.
