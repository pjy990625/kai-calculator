#!/usr/bin/env bash
# Runs supabase/setup.sql + tests/db/test.sql against a throwaway local
# PostgreSQL cluster. Needs PostgreSQL 15+ server binaries installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
	echo "PostgreSQL server binaries not found. Set PGBIN=/path/to/postgres/bin" >&2
	exit 1
fi

WORK="$(mktemp -d)"
AS=()
if [ "$(id -u)" = "0" ]; then
	# initdb refuses to run as root.
	chown postgres "$WORK"
	AS=(runuser -u postgres --)
fi

cleanup() {
	"${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
	rm -rf "$WORK"
}
trap cleanup EXIT

"${AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"${AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

PSQL=("${AS[@]}" "$PGBIN/psql" -h "$WORK" -U postgres -d postgres -X -q -A -t -o /dev/null -v ON_ERROR_STOP=1)
cat "$ROOT/tests/db/supabase-shim.sql" "$ROOT/supabase/setup.sql" | "${PSQL[@]}"
# Running setup.sql twice must work (safe re-run).
"${PSQL[@]}" < "$ROOT/supabase/setup.sql"
"${PSQL[@]}" < "$ROOT/tests/db/test.sql"
echo "db tests: all passed"
