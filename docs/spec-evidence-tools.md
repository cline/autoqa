# Spec: evidence tools for qbt

Items 1–4 have landed in `qwanban`; item 5 is open. Keep the JSON-L protocol
additive: old clients must keep working against a new backend and vice versa
(unknown fields ignored, unknown actions return the existing error shape).

Division of responsibility: qbt captures and buffers screens and renders
flip books; it knows nothing about cases or runs. The autoqa plugin owns the
journal: it decides which screenshots matter, copies them into the run
directory, and stitches the transcript. `publish_event` and the observatory
timeline are unchanged by this spec.

The agent holds the `computer` tool itself, so it sees every
`screenshot_id`, saves the ones that matter with `save_screenshot`, and
passes the returned paths to `autoqa_record`.

## 1. Screenshot ids on every capture (qbt)

Every action response that contains an `image` also contains
`"screenshot_id": "<id>"`, the same id the journal already assigns. Clients
that ignore it are unaffected.

Reason: the agent decides whether a screenshot matters after looking at it.
With the id in hand it can ask for that exact frame later.

## 2. `save_screenshot` action (qbt)

```jsonc
{ "id": 7, "action": "save_screenshot", "screenshot_id": "shot_123", "path": "runs/x/screenshots/a.png" }
→ { "id": 7, "saved": "/abs/path/a.png" }
```

Writes the buffered PNG to `path` (parents created). Relative paths resolve
against `qbt serve --artifact-root <dir>` (default: cwd); refuse `..`
segments and anything outside the root. An evicted id returns the existing
error shape with message `screenshot evicted`.

## 3. Retention (qbt)

`MAX_SCREENSHOTS` becomes `qbt serve --max-screenshots N`, default 200.
Print the estimated memory (`N × last PNG size`) once at startup so the
operator can see it. The buffer holds encoded PNG, not raw pixels, so 200
frames of a 1280×1024 desktop is on the order of 100 MB. If runs show
evictions before the agent has decided what to keep, raise the default then.

## 4. Flip books (qbt)

```
qbt flipbook --from <screenshot_id> --to <screenshot_id> --out <path>.webp [--fps 2]
```

Renders every buffered screenshot in the inclusive id range, in journal
order, into one animated WebP at a fixed frame rate (default 2 fps). Uses
the `image` crate's WebP encoder, lossy quality 75. No video codec, no GPU,
no background CPU; this runs on demand over the in-memory buffer via the
observatory WebSocket. Stills are not this tool's job: the autoqa plugin
saves the frames it considers significant with `save_screenshot` and places
them in the transcript beside the flip book.

## 5. Clipboard (qbt)

Actions `get_clipboard` → `{ "text": string | null }` and
`set_clipboard { "text": string }` → `{}`. Text only. Windows
`GetClipboardData(CF_UNICODETEXT)`; X11 the `CLIPBOARD` selection through the
existing PAL; macOS `NSPasteboard`.

## Acceptance

- Existing qbt tests pass unchanged.
- qbt integration test: `screenshot` returns `screenshot_id`;
  `save_screenshot` writes the file and refuses `..`; an evicted id errors.
- `flipbook` golden test on a synthetic 3-frame buffer.
- The computer-use README's wire protocol section documents every new field
  and action.
