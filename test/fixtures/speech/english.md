# Fix for the playback race

The bug was in `PlaybackController.next()`: it read the index before the previous chunk finished. I moved the update into the `onEnded` handler, so the state is consistent.

**Why it happened:** the audio player emits `ended` asynchronously, e.g. after the buffer drains. See [the Node.js docs](https://nodejs.org/api/events.html) and https://www.github.com/oven-sh/bun/issues/1234 for details.

Changes:

- Updated `src/core/playback/controller.ts`
- Added a regression test in `test/core/playback.test.ts`

```
bun test test/core
```

---

Version 1.2.3 includes the fix. Let me know if you want a CLI flag for it!
