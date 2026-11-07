#!/bin/sh
# Runs once, on the first start of an empty data volume: Keycloak gets its own role and database.
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$KEYCLOAK_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE keycloak LOGIN PASSWORD :'pw';
CREATE DATABASE keycloak OWNER keycloak;
SQL
