# Context evaluation harness

This manually replays one fixed recording corpus through the live Freestyle
server. It measures technical-term recall, cleanup spelling, cleanup
corruption, context-induced insertion, and streaming commit-to-final latency.

The harness calls the configured live speech and cleanup providers. Runs can
cost money. It has no CI or test-provider mode.

## Requirements

- Node 24
- `pw-record` and a working PipeWire microphone
- A running Freestyle server with voice and cleanup providers configured
- The fixture plugin linked into the server's user-data plugin directory

Run all commands below from the repository root unless noted otherwise.

## 1. Record the corpus once

```sh
scripts/eval-context/record.sh
```

For each missing recording, the script prints the line to read. Speak it,
then press Ctrl-C to finish that recording. Recordings are written beneath
`scripts/eval-context/recordings/` and are ignored by Git.

Re-run the script to continue. Existing recordings are skipped.

## 2. Link the fixture plugin

Choose one absolute scratch-file path and export it in every terminal used by
the app and harness:

```sh
export FREESTYLE_EVAL_SNAPSHOT_FILE="$PWD/scripts/eval-context/.snapshot.json"
```

The server discovers loose `.mjs` plugins directly in
`<userData>/plugins/`. Link the fixture plugin there:

```sh
export FREESTYLE_USER_DATA="/absolute/path/to/Freestyle/userData"
mkdir -p "$FREESTYLE_USER_DATA/plugins"
ln -s "$PWD/scripts/eval-context/fixture-plugin.mjs" \
  "$FREESTYLE_USER_DATA/plugins/eval-context-fixture.mjs"
```

Use the actual Freestyle user-data directory for the current installation.
The plugin reads `FREESTYLE_EVAL_SNAPSHOT_FILE` on every dictation. A missing
or unset file produces no snapshot.

The app must be started after the environment variable is exported so its
server process inherits the value. Confirm the server log reports
`freestyle-eval-context-fixture` as loaded.

Remove only this evaluation link after the run:

```sh
rm "$FREESTYLE_USER_DATA/plugins/eval-context-fixture.mjs"
```

## 3. Start Freestyle

Start the app or standalone server in the terminal that has
`FREESTYLE_EVAL_SNAPSHOT_FILE` exported. Configure the voice model, optional
cleanup model, provider credentials, and vocabulary in the app as usual.

The default loopback server needs no harness token. A server configured with
bearer authentication also needs:

```sh
export FREESTYLE_EVAL_SERVER_TOKEN="<token>"
```

The token is sent as an HTTP bearer token and as the WebSocket `token` query
parameter. It is never written to a result file.

## 4. Run the matrix

Run every configuration through both transports:

```sh
node scripts/eval-context/run.mjs \
  --server http://127.0.0.1:4649 \
  --all \
  --mode both
```

Run one configuration or a subset of corpus entries:

```sh
node scripts/eval-context/run.mjs \
  --server http://127.0.0.1:4649 \
  --config asr \
  --mode batch \
  --only screen-context-rust-log,stream-route-path
```

Each invocation replaces the selected
`results/<config>-<mode>.jsonl` files. The configurations are:

| Name | `context_enabled` | `context_to_asr` | `context_to_cleanup` |
| --- | --- | --- | --- |
| `baseline` | `false` | `false` | `false` |
| `vocab` | `false` | `false` | `false` |
| `asr` | `true` | `true` | `false` |
| `asr+cleanup` | `true` | `true` | `true` |

`vocab` uses the static vocabulary already configured by the user. The server
has no per-request switch for static vocabulary, so `baseline` also sees that
same vocabulary. To compare a truly empty-vocabulary baseline, run it before
adding evaluation vocabulary, then run `vocab` after adding it.

Before every request, the driver writes that entry's snapshot fixture. It
removes the fixture after the response. The original scratch-file contents,
if any, are restored when the run ends.

The driver reads the three context settings before it starts. It mutates only
those settings through `PUT /api/settings/:key`, then restores their exact
previous values. A key that did not previously exist is restored by deleting
it. Restoration is attempted after request failures and interrupts.

Batch requests send the WAV as a raw `audio/wav` body with
`x-audio-duration-ms`. Streaming waits for the initial `config`, sends
`start`, waits for the recording's `session.ready`, then sends 16 kHz mono
s16le PCM in real-time 80 ms chunks before `commit`.

The WebSocket `final` message exposes only final `text`, not separate raw and
cleaned text. Stream result rows therefore store `raw: null`. Raw recall and
cleanup-corruption metrics are unavailable for stream rows.

## 5. Score the results

```sh
node scripts/eval-context/score.mjs \
  --results scripts/eval-context/results
```

The table reports:

- Raw recall: case-insensitive recall of reference technical terms in `raw`
- Clean exact: exact spelling and capitalization in `cleaned`
- Corrupt: terms exact in `raw` that are no longer exact in `cleaned`
- Insert: percentage of eligible utterances where a snapshot-only technical
  candidate appears exactly in `cleaned`
- Mean and median streaming commit-to-final latency in milliseconds

Failed result rows are counted in the `Errors` column and excluded from metric
denominators.
