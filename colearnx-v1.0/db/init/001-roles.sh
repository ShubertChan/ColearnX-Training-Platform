#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$COLEARNX_APP_PASSWORD" \
  --set=migrator_password="$COLEARNX_MIGRATOR_PASSWORD" \
  --set=readonly_password="$COLEARNX_READONLY_PASSWORD" <<'EOSQL'
CREATE ROLE colearnx_migrator LOGIN PASSWORD :'migrator_password';
CREATE ROLE colearnx_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE colearnx_readonly LOGIN PASSWORD :'readonly_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE colearnx TO colearnx_migrator, colearnx_app, colearnx_readonly;
EOSQL
