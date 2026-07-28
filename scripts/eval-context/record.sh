#!/usr/bin/env bash

set -u

cd "$(dirname "$0")"

if ! command -v pw-record >/dev/null 2>&1; then
  echo "pw-record is required" >&2
  exit 1
fi

mkdir -p recordings

while IFS=$'\t' read -r id speak; do
  recording="recordings/${id}.wav"
  if [[ -f "$recording" ]]; then
    continue
  fi

  echo
  echo "[$id]"
  echo "$speak"
  echo "Recording to $recording. Press Ctrl-C when finished."

  trap ':' INT
  pw-record \
    --rate 16000 \
    --channels 1 \
    --format s16 \
    "$recording"

  status=$?
  trap - INT
  if [[ $status -ne 0 && $status -ne 130 ]]; then
    echo "pw-record failed with status $status" >&2
    exit "$status"
  fi
done < <(
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const corpus = JSON.parse(readFileSync(process.argv[1], "utf8"));
    for (const entry of corpus) {
      process.stdout.write(`${entry.id}\t${entry.speak}\n`);
    }
  ' corpus.json
)
