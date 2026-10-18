#!/bin/sh
set -eu
# psql reads passwords from its environment, never command arguments or logs.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv owner_password JADER_OWNER_PASSWORD
\getenv runtime_password JADER_RUNTIME_PASSWORD
CREATE ROLE jader_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'owner_password';
CREATE ROLE jader_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';
ALTER ROLE jader_runtime SET search_path = pg_catalog, public;
ALTER ROLE jader_runtime SET statement_timeout = '15s';
ALTER ROLE jader_runtime SET lock_timeout = '5s';
ALTER ROLE jader_runtime SET idle_in_transaction_session_timeout = '30s';
ALTER DATABASE jader_market OWNER TO jader_owner;
ALTER SCHEMA public OWNER TO jader_owner;
REVOKE ALL ON DATABASE jader_market FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
