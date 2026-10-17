-- =====================================================================
-- Kai Calculator — Supabase database setup
--
-- How to use: Supabase dashboard → SQL Editor → New query → paste this
-- whole file → Run. Safe to run again later (functions are replaced,
-- existing data is kept).
--
-- After running it, set the passwords ONCE in the SQL editor
-- (they are NOT stored in this file or in GitHub):
--
--   select private.set_password('staff', '서버 PIN');
--   select private.set_password('kitchen', '주방 PIN');
--   select private.set_password('admin', '관리자 비밀번호 (8자 이상)');
--
-- Three logins: the servers' PIN ('staff') sees only servers' hours and tips,
-- the kitchen PIN ('kitchen') sees only the kitchen and sushi bar, the admin
-- sees everything. The database decides what each one gets.
--
-- Security model
--   * All tables live in the `private` schema, which the Supabase API
--     does not expose. The browser can only call the public.* functions
--     below, and every rule (password, staff can only change today's
--     record, admin-only actions, 1-year retention) is enforced here,
--     not in the browser.
--   * Passwords are stored as bcrypt hashes. Session tokens are random;
--     only their SHA-256 is stored.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists private.config (
	id                int primary key default 1 check (id = 1),
	restaurant_name   text not null default '',
	server_pct        int  not null default 60 check (server_pct between 1 and 100),
	period_anchor     date not null default '2026-01-05',
	timezone          text not null default 'America/Los_Angeles',
	retention_months  int  not null default 12 check (retention_months between 1 and 24),
	staff_hash        text,
	admin_hash        text
);
insert into private.config (id) values (1) on conflict (id) do nothing;
alter table private.config add column if not exists kitchen_hash text;
-- Older versions kept records for 3 months (the old default). Keep them for
-- 1 year now. Only the old default is changed, so re-running this file never
-- undoes a value set on purpose. Records already deleted cannot come back.
alter table private.config alter column retention_months set default 12;
update private.config set retention_months = 12 where id = 1 and retention_months = 3;
-- Older versions let staff edit for N hours after the first save. Staff can
-- now edit until the end of the record's own date, so the setting is gone.
alter table private.config drop column if exists edit_window_hours;

create table if not exists private.servers (
	id         uuid primary key default gen_random_uuid(),
	name       text not null check (char_length(name) between 1 and 60),
	active     boolean not null default true,
	created_at timestamptz not null default now()
);
create unique index if not exists servers_name_ci on private.servers (lower(name));
-- Older versions had a manual order. Servers are now always listed by name.
alter table private.servers drop column if exists sort_order;
-- Everyone who shares tips is in this table: servers (60%), and the kitchen
-- and sushi bar (40%, split by hours across both). Existing rows are servers.
alter table private.servers add column if not exists team text not null default 'server';
alter table private.servers drop constraint if exists servers_team_check;
alter table private.servers add constraint servers_team_check check (team in ('server', 'kitchen', 'sushi'));

create table if not exists private.days (
	date             date primary key,
	day_tips_cents   bigint not null check (day_tips_cents between 0 and 100000000),
	-- Whole-day total. NULL until it is entered at closing.
	total_tips_cents bigint check (total_tips_cents is null or total_tips_cents between day_tips_cents and 100000000),
	created_at       timestamptz not null default now(),
	updated_at       timestamptz not null default now(),
	created_by       text not null,
	updated_by       text not null
);

create table if not exists private.hours (
	date       date not null references private.days (date) on delete cascade,
	server_id  uuid not null references private.servers (id),
	shift      text not null check (shift in ('day', 'night')),
	hundredths int  not null check (hundredths between 1 and 2400), -- 550 = 5.5 h
	primary key (date, server_id, shift)
);
create index if not exists hours_server_id on private.hours (server_id);

-- Kitchen and sushi bar: one number per person per day (the whole day, not
-- per shift), entered by the admin from the paper sheet. No link to
-- private.days: the hours can be entered before or after the tips.
create table if not exists private.kitchen_hours (
	date       date not null,
	server_id  uuid not null references private.servers (id),
	hundredths int  not null check (hundredths between 1 and 2400),
	primary key (date, server_id)
);
create index if not exists kitchen_hours_server_id on private.kitchen_hours (server_id);

create table if not exists private.sessions (
	token_hash bytea primary key,
	role       text not null check (role in ('staff', 'admin')),
	created_at timestamptz not null default now(),
	expires_at timestamptz not null
);
alter table private.sessions drop constraint if exists sessions_role_check;
alter table private.sessions add constraint sessions_role_check check (role in ('staff', 'kitchen', 'admin'));

create table if not exists private.login_attempts (
	id bigint generated always as identity primary key,
	ip text not null,
	at timestamptz not null default now()
);
create index if not exists login_attempts_at on private.login_attempts (at);

create table if not exists private.audit_log (
	id     bigint generated always as identity primary key,
	at     timestamptz not null default now(),
	role   text not null,
	action text not null,
	detail jsonb
);
-- private.purge() runs on every save and deletes old rows by `at`.
create index if not exists audit_log_at on private.audit_log (at);

-- Errors the app ran into (failed saves, lost connection, app bugs), so the
-- admin can see what went wrong on someone's phone. Kept for 90 days.
create table if not exists private.error_log (
	id         bigint generated always as identity primary key,
	at         timestamptz not null default now(),  -- when the database received it
	client_at  timestamptz,                          -- when it happened on the phone
	role       text not null,
	code       text not null,
	message    text,
	context    text,
	page       text,
	user_agent text
);
create index if not exists error_log_at on private.error_log (at);

-- Defense in depth: RLS on, and no policies → no direct access at all.
alter table private.config         enable row level security;
alter table private.servers        enable row level security;
alter table private.days           enable row level security;
alter table private.hours          enable row level security;
alter table private.kitchen_hours  enable row level security;
alter table private.sessions       enable row level security;
alter table private.login_attempts enable row level security;
alter table private.audit_log      enable row level security;
alter table private.error_log      enable row level security;

-- ---------------------------------------------------------------------
-- Internal helpers (not callable from the API)
-- ---------------------------------------------------------------------

create or replace function private.fail(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
	-- The message is a stable code the browser translates.
	raise exception using errcode = 'P0001', message = p_code;
end;
$$;

create or replace function private.cfg()
returns private.config
language sql
stable
set search_path = ''
as $$
	select c from private.config c where c.id = 1;
$$;

-- "Today" in the restaurant's time zone.
create or replace function private.today()
returns date
language sql
stable
set search_path = ''
as $$
	select (now() at time zone c.timezone)::date from private.config c where c.id = 1;
$$;

-- Oldest date that is kept (older data is deleted).
create or replace function private.retention_start()
returns date
language sql
stable
set search_path = ''
as $$
	select (private.today() - make_interval(months => c.retention_months))::date
	from private.config c where c.id = 1;
$$;

create or replace function private.client_ip()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
	v_headers json;
	v_ip text;
begin
	begin
		v_headers := nullif(current_setting('request.headers', true), '')::json;
	exception when others then
		v_headers := null;
	end;
	v_ip := trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1));
	return coalesce(nullif(v_ip, ''), 'unknown');
end;
$$;

-- Returns 'staff' (servers), 'kitchen' or 'admin' for a valid token, otherwise fails.
create or replace function private.session_role(p_token text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
	v_role text;
begin
	if p_token is null or length(p_token) <> 64 then
		perform private.fail('not_authenticated');
	end if;
	select s.role into v_role
	from private.sessions s
	where s.token_hash = extensions.digest(p_token, 'sha256')
		and s.expires_at > now();
	if v_role is null then
		perform private.fail('not_authenticated');
	end if;
	return v_role;
end;
$$;

create or replace function private.require_admin(p_token text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
	if private.session_role(p_token) <> 'admin' then
		perform private.fail('admin_only');
	end if;
end;
$$;

create or replace function private.log(p_role text, p_action text, p_detail jsonb)
returns void
language sql
set search_path = ''
as $$
	insert into private.audit_log (role, action, detail) values (p_role, p_action, p_detail);
$$;

-- Deletes data older than the retention period, plus expired sessions.
create or replace function private.purge()
returns void
language plpgsql
set search_path = ''
as $$
declare
	v_start date := private.retention_start();
	v_months int := (private.cfg()).retention_months;
begin
	delete from private.days d where d.date < v_start; -- hours cascade
	delete from private.kitchen_hours k where k.date < v_start;
	delete from private.sessions s where s.expires_at <= now();
	delete from private.login_attempts a where a.at < now() - interval '1 day';
	delete from private.audit_log l where l.at < now() - make_interval(months => v_months);
	delete from private.error_log e where e.at < now() - interval '90 days';
end;
$$;

create or replace function private.clean_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
	select trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
$$;

-- Is p_password already the password of another login? The servers' PIN, the
-- kitchen PIN and the admin password must all differ, or one would open another.
create or replace function private.password_taken(p_kind text, p_password text)
returns boolean
language sql
stable
set search_path = ''
as $$
	select exists (
		select 1 from private.config c,
			lateral (values ('staff', c.staff_hash), ('kitchen', c.kitchen_hash), ('admin', c.admin_hash)) h(kind, hash)
		where c.id = 1 and h.kind <> p_kind and h.hash is not null
			and extensions.crypt(p_password, h.hash) = h.hash
	);
$$;

-- Stores a new password for one login and logs out everyone using it
-- (except the session p_keep, if given).
create or replace function private.store_password(p_kind text, p_password text, p_keep bytea default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
	v_hash text := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
begin
	update private.config c set
		staff_hash = case when p_kind = 'staff' then v_hash else c.staff_hash end,
		kitchen_hash = case when p_kind = 'kitchen' then v_hash else c.kitchen_hash end,
		admin_hash = case when p_kind = 'admin' then v_hash else c.admin_hash end
	where c.id = 1;
	delete from private.sessions s where s.role = p_kind and s.token_hash is distinct from p_keep;
end;
$$;

-- Set a password. Run from the SQL editor: select private.set_password('staff', '1234');
-- Kinds: 'staff' (servers' PIN), 'kitchen' (kitchen PIN), 'admin'. Logs out everyone using that login.
create or replace function private.set_password(p_kind text, p_password text)
returns text
language plpgsql
set search_path = ''
as $$
begin
	if p_kind is null or p_kind not in ('staff', 'kitchen', 'admin') then
		raise exception 'kind must be staff, kitchen or admin';
	end if;
	if p_password is null or length(p_password) > 200
		or length(p_password) < (case when p_kind = 'admin' then 8 else 4 end) then
		raise exception 'password too short (PIN: 4+, admin: 8+ characters)';
	end if;
	if private.password_taken(p_kind, p_password) then
		raise exception 'the servers'' PIN, the kitchen PIN and the admin password must be different';
	end if;
	perform private.store_password(p_kind, p_password);
	return 'ok';
end;
$$;

-- The oldest date staff can still add or change: a day stays open to staff for
-- one week, counting the day itself (Monday's tips until Sunday 11:59 PM).
-- On a busy night the tips are often worked out the next day or later.
create or replace function private.staff_edit_from()
returns date
language sql
stable
set search_path = ''
as $$
	select private.today() - 6;
$$;

-- Can this role add or change the record of p_date right now?
-- Staff (servers): the last 7 days (see staff_edit_from). Older days are closed and only
-- the admin can change them. A past day also needs the name of the person
-- changing it (see save_shifts), which the app asks for when "Edit" is tapped.
drop function if exists private.can_edit(text, date, timestamptz); -- older signature
create or replace function private.can_edit(p_role text, p_date date)
returns boolean
language sql
stable
set search_path = ''
as $$
	select case
		when p_date is null or p_date < private.retention_start() or p_date > private.today() then false
		when p_role = 'admin' then true
		when p_role = 'staff' then p_date >= private.staff_edit_from()
		else false -- the kitchen login only views
	end;
$$;

-- Checks a list of hours for ONE shift (or one day of the kitchen):
--   [{"server_id": "...", "hundredths": 550}, ...]   (550 = 5.5 h)
-- Everyone in it must be in one of p_teams (servers' hours: 'server' only).
drop function if exists private.check_hours(jsonb); -- older signature
create or replace function private.check_hours(p_hours jsonb, p_teams text[])
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
	v_e jsonb;
	v_h numeric;
begin
	if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 200 then
		perform private.fail('invalid_hours');
	end if;
	for v_e in select value from jsonb_array_elements(p_hours) loop
		if jsonb_typeof(v_e) <> 'object'
			or jsonb_typeof(v_e -> 'hundredths') is distinct from 'number'
			or coalesce(v_e ->> 'server_id', '') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' then
			perform private.fail('invalid_hours');
		end if;
		v_h := (v_e ->> 'hundredths')::numeric;
		if v_h <> trunc(v_h) or v_h < 1 or v_h > 2400 then
			perform private.fail('invalid_hours');
		end if;
		if not exists (select 1 from private.servers s where s.id = (v_e ->> 'server_id')::uuid and s.team = any (p_teams)) then
			perform private.fail('unknown_server');
		end if;
	end loop;
	-- The same server twice in one shift.
	if (select count(*) <> count(distinct lower(e ->> 'server_id')) from jsonb_array_elements(p_hours) e) then
		perform private.fail('invalid_hours');
	end if;
end;
$$;

create or replace function private.server_json(p_id uuid)
returns json
language sql
stable
set search_path = ''
as $$
	select json_build_object('id', s.id, 'name', s.name, 'active', s.active, 'team', s.team)
	from private.servers s where s.id = p_id;
$$;

-- Which teams a login may see: servers see servers, the kitchen login sees
-- the kitchen and sushi bar, the admin sees everyone.
create or replace function private.sees_team(p_role text, p_team text)
returns boolean
language sql
immutable
set search_path = ''
as $$
	select case p_role
		when 'admin' then true
		when 'staff' then p_team = 'server'
		when 'kitchen' then p_team in ('kitchen', 'sushi')
		else false
	end;
$$;

-- ---------------------------------------------------------------------
-- Public API (called from the browser)
-- ---------------------------------------------------------------------

create or replace function public.login(p_password text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_ip text := private.client_ip();
	v_cfg private.config;
	v_role text;
	v_token text;
begin
	perform private.purge();

	-- Brute-force protection. A failed login RETURNS (not raises) so the
	-- recorded attempt is committed.
	if (select count(*) from private.login_attempts a where a.ip = v_ip and a.at > now() - interval '15 minutes') >= 5
		or (select count(*) from private.login_attempts a where a.at > now() - interval '1 hour') >= 30 then
		return json_build_object('ok', false, 'error', 'too_many_attempts');
	end if;

	v_cfg := private.cfg();
	if v_cfg.staff_hash is null and v_cfg.kitchen_hash is null and v_cfg.admin_hash is null then
		return json_build_object('ok', false, 'error', 'not_configured');
	end if;

	if p_password is not null and length(p_password) between 1 and 200 then
		if v_cfg.admin_hash is not null and extensions.crypt(p_password, v_cfg.admin_hash) = v_cfg.admin_hash then
			v_role := 'admin';
		elsif v_cfg.staff_hash is not null and extensions.crypt(p_password, v_cfg.staff_hash) = v_cfg.staff_hash then
			v_role := 'staff';
		elsif v_cfg.kitchen_hash is not null and extensions.crypt(p_password, v_cfg.kitchen_hash) = v_cfg.kitchen_hash then
			v_role := 'kitchen';
		end if;
	end if;

	if v_role is null then
		insert into private.login_attempts (ip) values (v_ip);
		return json_build_object('ok', false, 'error', 'bad_password');
	end if;

	v_token := encode(extensions.gen_random_bytes(32), 'hex');
	insert into private.sessions (token_hash, role, expires_at)
	values (
		extensions.digest(v_token, 'sha256'),
		v_role,
		now() + case when v_role = 'admin' then interval '7 days' else interval '30 days' end
	);
	return json_build_object('ok', true, 'token', v_token, 'role', v_role);
end;
$$;

create or replace function public.logout(p_token text)
returns json
language sql
security definer
set search_path = ''
as $$
	delete from private.sessions s where s.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256');
	select json_build_object('ok', true);
$$;

create or replace function public.get_bootstrap(p_token text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := private.session_role(p_token);
	v_cfg private.config := private.cfg();
begin
	return json_build_object(
		'role', v_role,
		'today', private.today(),
		'retention_start', private.retention_start(),
		'staff_edit_from', private.staff_edit_from(),
		'settings', json_build_object(
			'restaurant_name', v_cfg.restaurant_name,
			'server_pct', v_cfg.server_pct,
			'period_anchor', v_cfg.period_anchor,
			'timezone', v_cfg.timezone,
			'retention_months', v_cfg.retention_months
		),
		'servers', coalesce((
			-- By name; the browser re-sorts with its own (language-aware) rules.
			select json_agg(json_build_object('id', s.id, 'name', s.name, 'active', s.active, 'team', s.team)
				order by lower(s.name), s.id)
			from private.servers s
			where private.sees_team(v_role, s.team)
		), '[]'::json)
	);
end;
$$;

create or replace function public.get_range(p_token text, p_from date, p_to date)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := private.session_role(p_token);
begin
	if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 100 then
		perform private.fail('invalid_range');
	end if;
	return json_build_object(
		'today', private.today(),
		'now', now(),
		'retention_start', private.retention_start(),
		'staff_edit_from', private.staff_edit_from(),
		'days', coalesce((
			select json_agg(json_build_object(
				'date', d.date,
				'day_tips_cents', d.day_tips_cents,
				'total_tips_cents', d.total_tips_cents,
				'created_at', d.created_at,
				'updated_at', d.updated_at,
				'editable', private.can_edit(v_role, d.date)
			) order by d.date)
			from private.days d where d.date between p_from and p_to
		), '[]'::json),
		-- Servers' hours: servers and the admin. The kitchen's: the kitchen login and the admin.
		'hours', coalesce((
			select json_agg(json_build_object('date', h.date, 'server_id', h.server_id, 'shift', h.shift, 'hundredths', h.hundredths)
				order by h.date, h.shift)
			from private.hours h where h.date between p_from and p_to and v_role in ('staff', 'admin')
		), '[]'::json),
		'kitchen_hours', coalesce((
			select json_agg(json_build_object('date', k.date, 'server_id', k.server_id, 'hundredths', k.hundredths)
				order by k.date)
			from private.kitchen_hours k where k.date between p_from and p_to and v_role in ('kitchen', 'admin')
		), '[]'::json)
	);
end;
$$;

-- Save one date. The day shift and the night shift are saved separately, so
-- the person entering night tips at closing can never overwrite what someone
-- else entered for lunch (and the other way round).
--
--   p_day_hours   NULL → leave the day shift as it is.
--                 else → set day tips to p_day_tips_cents and replace the day hours.
--   p_night_hours NULL → leave the night shift as it is.
--                 else → set the whole-day total to p_total_tips_cents (NULL = not
--                        entered yet) and replace the night hours.
--   hours: [{"server_id": "...", "hundredths": 550}, ...]
--
-- Night tips are never stored: night tips = whole-day total − day tips.
--   p_editor      who is changing a past day (a server id). Staff must give it for
--                 any date before today; it goes into the audit log.
drop function if exists public.save_shifts(text, date, bigint, jsonb, bigint, jsonb); -- older signature
create or replace function public.save_shifts(
	p_token text,
	p_date date,
	p_day_tips_cents bigint,
	p_day_hours jsonb,
	p_total_tips_cents bigint,
	p_night_hours jsonb,
	p_editor uuid default null
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := private.session_role(p_token);
	v_existing private.days;
	v_set_day boolean := p_day_hours is not null;
	v_set_night boolean := p_night_hours is not null;
	v_day bigint;
	v_total bigint;
	v_editor text;
	v_past boolean := p_date < private.today();
	v_before_day jsonb;
	v_before_night jsonb;
begin
	if p_date is null then
		perform private.fail('invalid_date');
	end if;
	if p_date > private.today() then
		perform private.fail('future_date');
	end if;
	if p_date < private.retention_start() then
		perform private.fail('too_old');
	end if;
	if not v_set_day and not v_set_night then
		perform private.fail('invalid_hours'); -- nothing to save
	end if;

	select d.* into v_existing from private.days d where d.date = p_date for update;
	if not private.can_edit(v_role, p_date) then
		perform private.fail(case when v_existing.date is null then 'date_locked' else 'locked' end);
	end if;
	if p_editor is not null then
		select s.name into v_editor from private.servers s where s.id = p_editor;
	end if;
	if v_past and v_role <> 'admin' and v_editor is null then
		perform private.fail('editor_required'); -- "Edit" was not tapped (or an old version of the page)
	end if;

	-- The shift that is not being saved keeps what is stored.
	v_day := case when v_set_day then p_day_tips_cents else coalesce(v_existing.day_tips_cents, 0) end;
	v_total := case when v_set_night then p_total_tips_cents else v_existing.total_tips_cents end;
	if v_day is null or v_day not between 0 and 100000000
		or (v_total is not null and v_total not between v_day and 100000000) then
		perform private.fail('invalid_tips');
	end if;
	if v_set_day then
		perform private.check_hours(p_day_hours, array['server']);
	end if;
	if v_set_night then
		perform private.check_hours(p_night_hours, array['server']);
	end if;

	begin
		insert into private.days as d (date, day_tips_cents, total_tips_cents, created_by, updated_by)
		values (p_date, v_day, v_total, v_role, v_role)
		on conflict (date) do update set
			-- Only the columns of the shift being saved (matters when two phones save at once).
			day_tips_cents = case when v_set_day then excluded.day_tips_cents else d.day_tips_cents end,
			total_tips_cents = case when v_set_night then excluded.total_tips_cents else d.total_tips_cents end,
			updated_at = now(),
			updated_by = v_role;
	exception when check_violation then
		perform private.fail('invalid_tips'); -- whole-day total below day tips
	end;

	-- The hours as they were, for the audit log.
	select jsonb_agg(jsonb_build_object('server_id', h.server_id, 'hundredths', h.hundredths) order by h.server_id) filter (where h.shift = 'day'),
		jsonb_agg(jsonb_build_object('server_id', h.server_id, 'hundredths', h.hundredths) order by h.server_id) filter (where h.shift = 'night')
	into v_before_day, v_before_night
	from private.hours h where h.date = p_date;

	if v_set_day then
		delete from private.hours h where h.date = p_date and h.shift = 'day';
		insert into private.hours (date, server_id, shift, hundredths)
		select p_date, (e ->> 'server_id')::uuid, 'day', (e ->> 'hundredths')::int
		from jsonb_array_elements(p_day_hours) e;
	end if;
	if v_set_night then
		delete from private.hours h where h.date = p_date and h.shift = 'night';
		insert into private.hours (date, server_id, shift, hundredths)
		select p_date, (e ->> 'server_id')::uuid, 'night', (e ->> 'hundredths')::int
		from jsonb_array_elements(p_night_hours) e;
	end if;

	perform private.log(v_role, case when v_existing.date is null then 'create_day' else 'update_day' end, jsonb_build_object(
		'date', p_date,
		'past_day', v_past,
		'editor', case when v_editor is null then null else jsonb_build_object('id', p_editor, 'name', v_editor) end,
		'before', case when v_existing.date is null then null else jsonb_build_object(
			'day_tips_cents', v_existing.day_tips_cents, 'total_tips_cents', v_existing.total_tips_cents,
			'day_hours', coalesce(v_before_day, '[]'::jsonb), 'night_hours', coalesce(v_before_night, '[]'::jsonb)) end,
		'after', jsonb_build_object('day_tips_cents', v_day, 'total_tips_cents', v_total,
			'day_hours', p_day_hours, 'night_hours', p_night_hours)
	));
	perform private.purge();
	return json_build_object('ok', true, 'date', p_date);
end;
$$;

-- OLD API, kept only for phones that still have the previous version of the
-- page open: replaces the whole record of one date in one call.
-- p_hours: [{"server_id": "...", "shift": "day"|"night", "hundredths": 550}, ...]
-- The app itself now calls save_shifts. Safe to delete once every phone has
-- reloaded the page (a few days after the update).
create or replace function public.save_day(
	p_token text,
	p_date date,
	p_day_tips_cents bigint,
	p_total_tips_cents bigint,
	p_hours jsonb
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
	if p_hours is null or jsonb_typeof(p_hours) <> 'array' or exists (
		select 1 from jsonb_array_elements(p_hours) e
		where jsonb_typeof(e) <> 'object' or coalesce(e ->> 'shift', '') not in ('day', 'night')
	) then
		perform private.fail('invalid_hours');
	end if;
	return public.save_shifts(
		p_token, p_date,
		p_day_tips_cents,
		(select coalesce(jsonb_agg(e - 'shift'), '[]'::jsonb) from jsonb_array_elements(p_hours) e where e ->> 'shift' = 'day'),
		p_total_tips_cents,
		(select coalesce(jsonb_agg(e - 'shift'), '[]'::jsonb) from jsonb_array_elements(p_hours) e where e ->> 'shift' = 'night')
	);
end;
$$;

create or replace function public.delete_day(p_token text, p_date date)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := private.session_role(p_token);
	v_existing private.days;
begin
	select d.* into v_existing from private.days d where d.date = p_date for update;
	if v_existing.date is null then
		perform private.fail('not_found');
	end if;
	-- Staff can change yesterday, but deleting a past day stays with the admin.
	if not private.can_edit(v_role, p_date) or (v_role <> 'admin' and p_date <> private.today()) then
		perform private.fail('locked');
	end if;
	delete from private.days d where d.date = p_date;
	perform private.log(v_role, 'delete_day', jsonb_build_object('date', p_date,
		'day_tips_cents', v_existing.day_tips_cents, 'total_tips_cents', v_existing.total_tips_cents));
	return json_build_object('ok', true);
end;
$$;

-- Servers can add servers; only the admin adds kitchen and sushi bar staff.
drop function if exists public.add_server(text, text); -- older signature
create or replace function public.add_server(p_token text, p_name text, p_team text default 'server')
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := private.session_role(p_token);
	v_name text := private.clean_name(p_name);
	v_team text := coalesce(p_team, 'server');
	v_id uuid;
begin
	if v_role = 'kitchen' or (v_team <> 'server' and v_role <> 'admin') then
		perform private.fail('admin_only');
	end if;
	if v_team not in ('server', 'kitchen', 'sushi') then
		perform private.fail('invalid_team');
	end if;
	if char_length(v_name) not between 1 and 60 then
		perform private.fail('invalid_name');
	end if;
	if exists (select 1 from private.servers s where lower(s.name) = lower(v_name)) then
		perform private.fail('duplicate_name');
	end if;
	insert into private.servers (name, team) values (v_name, v_team) returning id into v_id;
	perform private.log(v_role, 'add_server', jsonb_build_object('id', v_id, 'name', v_name, 'team', v_team));
	return private.server_json(v_id);
end;
$$;

-- Staff can add servers, but only the admin can change an existing name.
create or replace function public.rename_server(p_token text, p_id uuid, p_name text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_name text := private.clean_name(p_name);
	v_old text;
begin
	perform private.require_admin(p_token);
	if char_length(v_name) not between 1 and 60 then
		perform private.fail('invalid_name');
	end if;
	select s.name into v_old from private.servers s where s.id = p_id for update;
	if v_old is null then
		perform private.fail('not_found');
	end if;
	if exists (select 1 from private.servers s where lower(s.name) = lower(v_name) and s.id <> p_id) then
		perform private.fail('duplicate_name');
	end if;
	update private.servers s set name = v_name where s.id = p_id;
	perform private.log('admin', 'rename_server', jsonb_build_object('id', p_id, 'from', v_old, 'to', v_name));
	return private.server_json(p_id);
end;
$$;

create or replace function public.set_server_active(p_token text, p_id uuid, p_active boolean)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform private.require_admin(p_token);
	update private.servers s set active = coalesce(p_active, true) where s.id = p_id;
	if not found then
		perform private.fail('not_found');
	end if;
	perform private.log('admin', 'set_server_active', jsonb_build_object('id', p_id, 'active', p_active));
	return private.server_json(p_id);
end;
$$;

create or replace function public.delete_server(p_token text, p_id uuid)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_name text;
begin
	perform private.require_admin(p_token);
	if exists (select 1 from private.hours h where h.server_id = p_id)
		or exists (select 1 from private.kitchen_hours k where k.server_id = p_id) then
		perform private.fail('server_has_hours');
	end if;
	delete from private.servers s where s.id = p_id returning s.name into v_name;
	if v_name is null then
		perform private.fail('not_found');
	end if;
	perform private.log('admin', 'delete_server', jsonb_build_object('id', p_id, 'name', v_name));
	return json_build_object('ok', true);
end;
$$;

-- Moves someone between the servers, the kitchen and the sushi bar. Kitchen ↔
-- sushi bar is always fine (same 40% pool); a move between servers and the
-- kitchen is refused once they have hours on the other side, so old days
-- keep adding up.
create or replace function public.set_server_team(p_token text, p_id uuid, p_team text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_old text;
begin
	perform private.require_admin(p_token);
	if p_team is null or p_team not in ('server', 'kitchen', 'sushi') then
		perform private.fail('invalid_team');
	end if;
	select s.team into v_old from private.servers s where s.id = p_id for update;
	if v_old is null then
		perform private.fail('not_found');
	end if;
	if (p_team = 'server') <> (v_old = 'server') and (
		exists (select 1 from private.hours h where h.server_id = p_id)
		or exists (select 1 from private.kitchen_hours k where k.server_id = p_id)) then
		perform private.fail('team_has_hours');
	end if;
	update private.servers s set team = p_team where s.id = p_id;
	perform private.log('admin', 'set_server_team', jsonb_build_object('id', p_id, 'from', v_old, 'to', p_team));
	return private.server_json(p_id);
end;
$$;

-- Admin: the kitchen and sushi bar hours of one date, from the paper sheet.
-- Replaces all of that date's kitchen hours.
--   p_hours: [{"server_id": "...", "hundredths": 950}, ...]   ([] = nobody)
create or replace function public.save_kitchen_hours(p_token text, p_date date, p_hours jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_before jsonb;
begin
	perform private.require_admin(p_token);
	if p_date is null then
		perform private.fail('invalid_date');
	end if;
	if p_date > private.today() then
		perform private.fail('future_date');
	end if;
	if p_date < private.retention_start() then
		perform private.fail('too_old');
	end if;
	perform private.check_hours(p_hours, array['kitchen', 'sushi']);

	select jsonb_agg(jsonb_build_object('server_id', k.server_id, 'hundredths', k.hundredths) order by k.server_id)
	into v_before
	from private.kitchen_hours k where k.date = p_date;

	delete from private.kitchen_hours k where k.date = p_date;
	insert into private.kitchen_hours (date, server_id, hundredths)
	select p_date, (e ->> 'server_id')::uuid, (e ->> 'hundredths')::int
	from jsonb_array_elements(p_hours) e;

	perform private.log('admin', 'save_kitchen_hours', jsonb_build_object(
		'date', p_date, 'before', coalesce(v_before, '[]'::jsonb), 'after', p_hours));
	perform private.purge();
	return json_build_object('ok', true, 'date', p_date);
end;
$$;

-- Older versions let the admin order servers by hand.
drop function if exists public.set_server_order(text, uuid[]);

create or replace function public.update_settings(
	p_token text,
	p_restaurant_name text,
	p_server_pct int,
	p_period_anchor date
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform private.require_admin(p_token);
	if p_server_pct is null or p_server_pct not between 1 and 100 or p_period_anchor is null
		or char_length(private.clean_name(p_restaurant_name)) > 60 then
		perform private.fail('invalid_settings');
	end if;
	update private.config c set
		restaurant_name = private.clean_name(p_restaurant_name),
		server_pct = p_server_pct,
		period_anchor = p_period_anchor
	where c.id = 1;
	perform private.log('admin', 'update_settings', jsonb_build_object(
		'restaurant_name', p_restaurant_name, 'server_pct', p_server_pct, 'period_anchor', p_period_anchor));
	return json_build_object('ok', true);
end;
$$;

-- Admin changes the servers' PIN, the kitchen PIN or the admin password from the app.
-- Everyone else using that role is logged out (the caller stays logged in).
create or replace function public.change_password(p_token text, p_kind text, p_new_password text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_my_hash bytea := extensions.digest(coalesce(p_token, ''), 'sha256');
begin
	perform private.require_admin(p_token);
	if p_kind is null or p_kind not in ('staff', 'kitchen', 'admin') or p_new_password is null or length(p_new_password) > 200
		or length(p_new_password) < (case when p_kind = 'admin' then 8 else 4 end) then
		perform private.fail('invalid_password');
	end if;
	-- All three must differ, or one password would open another login.
	if private.password_taken(p_kind, p_new_password) then
		perform private.fail('password_conflict');
	end if;
	perform private.store_password(p_kind, p_new_password, v_my_hash);
	perform private.log('admin', 'change_password', jsonb_build_object('kind', p_kind));
	return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Error log
-- ---------------------------------------------------------------------

-- The app sends the errors it ran into (up to 20 at a time). Only a
-- logged-in phone can write, and at most 200 entries per hour are kept,
-- so the public API key can't be used to flood the table.
create or replace function public.log_errors(p_token text, p_entries jsonb)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_role text := private.session_role(p_token);
	v_room int;
	v_added int;
begin
	if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
		return json_build_object('ok', true, 'added', 0);
	end if;
	v_room := greatest(0, 200 - (select count(*) from private.error_log e where e.at > now() - interval '1 hour'));
	insert into private.error_log (client_at, role, code, message, context, page, user_agent)
	select
		case when x->>'at' ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$' then (x->>'at')::timestamptz end,
		v_role,
		left(coalesce(nullif(x->>'code', ''), 'unknown'), 40),
		left(x->>'message', 1000),
		left(x->>'context', 2000),
		left(x->>'page', 40),
		left(x->>'ua', 300)
	from jsonb_array_elements(p_entries) with ordinality as e(x, n)
	where jsonb_typeof(x) = 'object' and n <= least(20, v_room);
	get diagnostics v_added = row_count;
	return json_build_object('ok', true, 'added', v_added);
end;
$$;

create or replace function public.get_error_log(p_token text)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
	perform private.require_admin(p_token);
	return coalesce((
		select json_agg(json_build_object(
			'at', coalesce(e.client_at, e.at), 'role', e.role, 'code', e.code, 'message', e.message,
			'context', e.context, 'page', e.page, 'ua', e.user_agent
		) order by e.id desc)
		from (select * from private.error_log order by id desc limit 500) e
	), '[]'::json);
end;
$$;

create or replace function public.clear_error_log(p_token text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
	perform private.require_admin(p_token);
	delete from private.error_log;
	perform private.log('admin', 'clear_error_log', null);
	return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- Permissions: nothing in `private` is reachable from the API;
-- only the public functions above can be called.
-- ---------------------------------------------------------------------

do $$
declare
	r record;
	v_api_roles text := (
		select string_agg(quote_ident(rolname), ', ')
		from pg_roles where rolname in ('anon', 'authenticated')
	);
begin
	execute 'revoke all on all tables in schema private from public';
	execute 'revoke all on all functions in schema private from public';
	if v_api_roles is not null then
		execute 'revoke all on schema private from ' || v_api_roles;
		execute 'revoke all on all tables in schema private from ' || v_api_roles;
		execute 'revoke all on all functions in schema private from ' || v_api_roles;
	end if;

	for r in
		select p.oid::regprocedure as sig
		from pg_proc p join pg_namespace n on n.oid = p.pronamespace
		where n.nspname = 'public'
			and p.proname in ('login', 'logout', 'get_bootstrap', 'get_range', 'save_shifts', 'save_day', 'delete_day',
				'add_server', 'rename_server', 'set_server_active', 'set_server_team', 'delete_server', 'save_kitchen_hours',
				'update_settings', 'change_password', 'log_errors', 'get_error_log', 'clear_error_log')
	loop
		execute format('revoke all on function %s from public', r.sig);
		if v_api_roles is not null then
			execute format('grant execute on function %s to %s', r.sig, v_api_roles);
		end if;
	end loop;
end;
$$;

-- Tell the Supabase API about new / removed functions right away.
notify pgrst, 'reload schema';
