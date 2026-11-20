# autoqa-slack

This is a Slack bot which connects Slack and AutoQA.

## Session storage

AutoQA stores session journals and fetched artifacts under
`~/.local/share/autoqa-slack/sessions/<channel>-<thread>/`. Set
`AUTOQA_STATE_DIR` to use a different root, including a persistent volume when
running in a container. Run only one bot process against a state directory.
Journals contain Slack conversation text and tool results; restrict access and
include the directory in your data-retention policy.

On startup, AutoQA restores session history and centralized job watches without
starting a worker for every thread. A new Slack message or job update wakes the
session. `SIGINT` and `SIGTERM` preserve state; mentioning `@AutoQA bye` stops
that session, removes its watches, and deletes its state. A later mention starts
a fresh conversation. Inactive sessions still expire according to
`AUTOQA_SESSION_TTL_MS` (default 24 hours); watched jobs prevent that expiry.

The opt-in `hold` tool waits 60 seconds by default (5–300 seconds allowed).
New human input cancels the timer immediately. AutoQA may hold silently once,
then ask a visible question and hold once more; it cannot keep holding without
another human message. Clear, complete requests do not need a hold. Hold
deadlines are intentionally not restored after a process restart.

Journal writes are serialized in the main process. An incomplete final record
is removed during recovery before further appends. Accepted inputs remain
pending until their transcript is committed, so an interrupted turn may run
again. External side effects, such as job submission, are not exactly-once;
check job state before retrying an interrupted request. Slack delivery itself
is not journaled: a crash after a turn commits but before its reply reaches
Slack can leave a reply in the saved history that the thread did not receive.
In-flight artifact downloads stop with their worker and may need to be fetched
again after restart; completed artifact paths are restored.

Legacy `.session-state.json` snapshots can be imported without deleting the
source. The old release used temporary directories without persisted Slack
routing metadata, so those sessions cannot be discovered and routed
automatically. Existing snapshots need their original channel/thread metadata
to resume. Older releases do not read the journal format; retain a backup
before rolling back.

## Tests

Use Node 24 and install dependencies with `npm ci`, then run:

```sh
npm test
```

See also:

- [Qwanban](https://github.com/dominiccooney/qwanban.git), specifically `control-tower`
- [AutoQA](https://github.com/cline/autoqa.git), a set of test cases
