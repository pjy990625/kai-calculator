-- Mimics the parts of a Supabase database that setup.sql relies on,
-- so it can be tested against a plain local PostgreSQL.
do $$ begin
	if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
	if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists extensions;
grant usage on schema extensions to public;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists test;
grant usage on schema test to anon;
