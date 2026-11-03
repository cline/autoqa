#!/bin/bash
set -euo pipefail

finish_script="$CONTROL_TOWER_JOB_ROOT/complete-job.sh"
cat > "$finish_script" <<'EOF'
#!/bin/bash
set -euo pipefail

outcome="${1:-}"
if [[ "$outcome" != "completed" && "$outcome" != "failed" ]]; then
  echo "Usage: $0 <completed|failed>" >&2
  exit 1
fi

for var in CONTROL_TOWER_JOB_ROOT CONTROL_TOWER_WORKER_URL CONTROL_TOWER_JOB_ID CLINE_COMPUTER_USE_PORT; do
  if [ -z "${!var:-}" ]; then
    echo "Missing $var in environment; run this from the Cline session" >&2
    exit 1
  fi
done

job_root="$CONTROL_TOWER_JOB_ROOT"
job_url="$CONTROL_TOWER_WORKER_URL/jobs/$CONTROL_TOWER_JOB_ID"

# 1. Stop qbt cleanly so its journal flushes to disk.
python3 - "$CLINE_COMPUTER_USE_PORT" <<'PY'
import json, socket, sys, time

port = int(sys.argv[1])
def port_open():
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False

if port_open():
    print("stopping qbt so its journal is flushed")
    with socket.create_connection(("127.0.0.1", port), timeout=5.0) as sock:
        sock.settimeout(5.0)
        sock.sendall(b'{"id":1,"action":"shutdown_backend"}\n')
        line = sock.makefile("r", encoding="utf-8").readline()
        if not line or json.loads(line).get("ok") is not True:
            raise RuntimeError(f"qbt rejected shutdown_backend: {line!r}")
    deadline = time.time() + 10.0
    while port_open() and time.time() < deadline:
        time.sleep(0.2)
    if port_open():
        raise RuntimeError(f"qbt port {port} still open after shutdown_backend")
PY

journal_tmp="$job_root/artifacts/journal/events.tmp"
for _ in $(seq 1 50); do
  [ ! -e "$journal_tmp" ] && break
  sleep 0.1
done
[ ! -e "$journal_tmp" ] || { echo "qbt journal left an uncommitted $journal_tmp" >&2; exit 1; }

# 2. Build immutable results.tar.zst (excluding package/ and cline-data/settings/).
archive="$job_root/package/results.tar.zst"
if [ ! -f "$archive" ]; then
  mkdir -p "$job_root/package"
  tmp="$archive.tmp"
  tar --zstd \
    --exclude='./package' \
    --exclude='./cline-data/settings' \
    -cf "$tmp" -C "$job_root" .
  if tar -tf "$tmp" | grep -q 'providers\.json'; then
    echo "Packet would include providers.json" >&2
    exit 1
  fi
  mv "$tmp" "$archive"
fi
echo "packet $archive ($(stat -c%s "$archive") bytes)"

# 3. Upload artifact and report completion directly to Control Tower (never via proxy).
post_retry() {
  local what="$1" url="$2" accept="$3"; shift 3
  local delay=1 code
  for attempt in 1 2 3 4 5; do
    code=$(curl --noproxy '*' -sS --max-time 300 -X POST -o /tmp/ct-reply.$$ -w '%{http_code}' "$@" "$url" || echo 000)
    if [[ ",$accept," == *",$code,"* ]]; then
      rm -f /tmp/ct-reply.$$
      echo "$code"
      return 0
    fi
    echo "$what attempt $attempt: HTTP $code $(cat /tmp/ct-reply.$$ 2>/dev/null)" >&2
    rm -f /tmp/ct-reply.$$
    sleep "$delay"
    delay=$(( delay * 2 > 10 ? 10 : delay * 2 ))
  done
  echo "CT rejected $what after 5 attempts" >&2
  return 1
}

code=$(post_retry "artifact upload" "$job_url/artifact" "201,204" \
  -H 'Content-Type: application/zstd' --data-binary "@$archive")
echo "CT stored the packet: HTTP $code"

post_retry "completion" "$job_url/complete" "202" \
  -H 'Content-Type: application/json' --data "{\"outcome\":\"$outcome\"}" >/dev/null
echo "CT accepted completion. This worker will be deleted."
EOF
chmod 0755 "$finish_script"

prompt_path="$CONTROL_TOWER_JOB_ROOT/prompt.txt"
{
  cat "$CONTROL_TOWER_RAW_PROMPT_FILE"
  cat <<EOF

Worker lifecycle:
Remain available for Friendzone steering until the job is finished.
Resolve outstanding Friendzone requests and save your final report in '$CONTROL_TOWER_JOB_ROOT'.

To finish, run:
'$finish_script' completed

Use 'failed' instead of 'completed' if you cannot complete the task.
The helper stops qbt, packages everything under '$CONTROL_TOWER_JOB_ROOT' (except package and
cline-data/settings) into one archive, uploads it to CT, and only then reports
the outcome. Save the final report and any files worth keeping under '$CONTROL_TOWER_JOB_ROOT'
BEFORE running it. Check that CT accepts both the packet and the completion.

Completion authorizes immediate VM and disk deletion.

If the operator asks to retain this worker for inspection, do not call
completion until released. CT's deadline still applies.
Exiting Cline or finishing a turn does not complete the job.
EOF
} > "$prompt_path"

cd "$HOME"
#echo "starting cline on $DISPLAY"
#exec xterm -maximized -e "$CLINE_BIN" --tui --auto-approve true --data-dir "$CLINE_DATA_DIR" -- \
#  "Read and carry out the task and lifecycle instructions in $prompt_path"

#echo "starting cline in headless tmux session (DISPLAY=$DISPLAY)"
#tmux new-session -d -s cline -x 120 -y 40 \
#  "\"$CLINE_BIN\" --tui --auto-approve true --data-dir \"$CLINE_DATA_DIR\" -- \"Read and carry out the task and lifecycle instructions in $prompt_path\"; rc=\$?; tmux wait-for -S cline-done; exit \$rc"
#tmux wait-for cline-done

echo "starting cline in headless PTY (DISPLAY=$DISPLAY)"
exec script --quiet --return --command \
  "stty cols 120 rows 40; exec \"$CLINE_BIN\" --tui --auto-approve true --data-dir \"$CLINE_DATA_DIR\" -- \"Read and carry out the task and lifecycle instructions in $prompt_path\"" \
  "$CONTROL_TOWER_JOB_ROOT/tui.log" >/dev/null
