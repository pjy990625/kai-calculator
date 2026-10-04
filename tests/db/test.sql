-- Database tests for supabase/setup.sql. Run with tests/db/run.sh.
-- Calls are made as the `anon` role, exactly like the browser does.

create or replace function test.ok(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
	if p_cond is not true then
		raise exception 'FAIL: %', p_msg;
	end if;
end;
$$;

-- Runs a statement and returns its error message (NULL if it succeeded).
create or replace function test.err(p_sql text)
returns text language plpgsql as $$
begin
	execute p_sql;
	return null;
exception when others then
	return sqlerrm;
end;
$$;
grant execute on all functions in schema test to anon;

select private.set_password('staff', '2468');
select private.set_password('admin', 'admin-pass-1');
select test.ok(test.err($$select private.set_password('admin', '2468')$$) is not null, 'admin password too short');
select test.ok(test.err($$select private.set_password('staff', 'admin-pass-1')$$) like '%must be different%', 'PIN cannot equal admin password');

\echo '-- direct access is blocked'
set role anon;
select set_config('request.headers', '{"x-forwarded-for":"10.0.0.1, 172.16.0.1"}', false);
select test.ok(test.err('select * from private.days') like 'permission denied%', 'anon must not read private.days');
select test.ok(test.err('select * from private.config') like 'permission denied%', 'anon must not read private.config');
select test.ok(test.err($$select private.set_password('staff', '1111')$$) like 'permission denied%', 'anon must not call private functions');

\echo '-- login'
select test.ok((public.login('wrong'))->>'error' = 'bad_password', 'wrong password rejected');
select test.ok((public.login(''))->>'error' = 'bad_password', 'empty password rejected');
select (public.login('2468'))->>'token' as staff_token \gset
select (public.login('admin-pass-1'))->>'token' as admin_token \gset
select test.ok(length(:'staff_token') = 64, 'staff token issued');
select test.ok((public.get_bootstrap(:'staff_token'))->>'role' = 'staff', 'PIN gives staff role');
select test.ok((public.get_bootstrap(:'admin_token'))->>'role' = 'admin', 'admin password gives admin role');
select test.ok(test.err($$select public.get_bootstrap('nope')$$) = 'not_authenticated', 'bad token rejected');
select test.ok((public.get_bootstrap(:'staff_token'))->'settings'->>'timezone' = 'America/Los_Angeles', 'LA time zone');
select test.ok((public.get_bootstrap(:'staff_token'))->'settings' ->> 'staff_hash' is null, 'hashes never returned');
select (public.get_bootstrap(:'staff_token'))->>'today' as today \gset

\echo '-- servers'
select (public.add_server(:'staff_token', '  Alice  '))->>'id' as alice \gset
select (public.add_server(:'staff_token', 'Bob'))->>'id' as bob \gset
select test.ok(test.err(format('select public.add_server(%L, %L)', :'staff_token', 'ALICE')) = 'duplicate_name', 'duplicate name (case-insensitive)');
select test.ok(test.err(format('select public.add_server(%L, %L)', :'staff_token', '   ')) = 'invalid_name', 'empty name');
select test.ok((public.rename_server(:'staff_token', :'bob', 'Bobby'))->>'name' = 'Bobby', 'staff can rename');
select test.ok(test.err(format('select public.set_server_active(%L, %L, false)', :'staff_token', :'bob')) = 'admin_only', 'staff cannot deactivate');
select test.ok(test.err(format('select public.update_settings(%L, %L, 60, %L)', :'staff_token', 'X', '2026-09-28')) = 'admin_only', 'staff cannot change settings');
select test.ok(test.err(format('select public.change_password(%L, %L, %L)', :'staff_token', 'staff', '1234')) = 'admin_only', 'staff cannot change passwords');
select test.ok((public.get_bootstrap(:'staff_token'))->'servers'->0->>'name' = 'Alice', 'name trimmed, order kept');

\echo '-- save_day validation'
\set hours '[{"server_id":":alice","shift":"day","hundredths":600},{"server_id":":bob","shift":"day","hundredths":400},{"server_id":":alice","shift":"night","hundredths":500}]'
select replace(replace(:'hours', ':alice', :'alice'), ':bob', :'bob') as hours \gset
select test.ok((public.save_day(:'staff_token', :'today'::date, 50000, 150000, :'hours'::jsonb))->>'ok' = 'true', 'staff saves today');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 500, 400, %L::jsonb)', :'staff_token', :'today', '[]')) = 'invalid_tips', 'total < day tips rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, -1, null, %L::jsonb)', :'staff_token', :'today', '[]')) = 'invalid_tips', 'negative tips rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today',
	format('[{"server_id":"%s","shift":"day","hundredths":2401}]', :'alice'))) = 'invalid_hours', 'over 24h rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today',
	format('[{"server_id":"%s","shift":"day","hundredths":5.5}]', :'alice'))) = 'invalid_hours', 'fractional hundredths rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today',
	format('[{"server_id":"%s","shift":"day","hundredths":100},{"server_id":"%s","shift":"day","hundredths":200}]', :'alice', :'alice'))) = 'invalid_hours', 'duplicate entries rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today',
	'[{"server_id":"00000000-0000-0000-0000-000000000000","shift":"day","hundredths":100}]')) = 'unknown_server', 'unknown server rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today', '{"a":1}')) = 'invalid_hours', 'non-array rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date + 1, 0, null, %L::jsonb)', :'staff_token', :'today', '[]')) = 'future_date', 'future date rejected');

\echo '-- get_range'
select test.ok(json_array_length((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days') = 1, 'one day');
select test.ok(json_array_length((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'hours') = 3, 'three hour rows');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'editable' = 'true', 'fresh record editable by staff');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'total_tips_cents' = '150000', 'total stored');
select test.ok(test.err(format('select public.get_range(%L, %L::date, %L::date - 1)', :'staff_token', :'today', :'today')) = 'invalid_range', 'reversed range rejected');
select test.ok(test.err(format('select public.get_range(%L, %L::date - 200, %L::date)', :'staff_token', :'today', :'today')) = 'invalid_range', 'huge range rejected');

\echo '-- which dates staff may create'
select test.ok((public.save_day(:'staff_token', :'today'::date - 1, 1000, null, '[]'::jsonb))->>'ok' = 'true', 'staff can create yesterday (after-midnight entry)');
select test.ok(test.err(format('select public.save_day(%L, %L::date - 3, 1000, null, %L::jsonb)', :'staff_token', :'today', '[]')) = 'date_locked', 'staff cannot back-fill 3 days ago');
select test.ok((public.save_day(:'admin_token', :'today'::date - 3, 1000, null, '[]'::jsonb))->>'ok' = 'true', 'admin can back-fill');

\echo '-- 24h lock'
reset role;
update private.days set created_at = now() - interval '25 hours' where date = :'today'::date;
set role anon;
select test.ok(test.err(format('select public.save_day(%L, %L::date, 1, null, %L::jsonb)', :'staff_token', :'today', '[]')) = 'locked', 'staff locked after 24h');
select test.ok(test.err(format('select public.delete_day(%L, %L::date)', :'staff_token', :'today')) = 'locked', 'staff cannot delete after 24h');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'editable' = 'false', 'shown as locked to staff');
select test.ok((public.get_range(:'admin_token', :'today'::date, :'today'::date))->'days'->0->>'editable' = 'true', 'admin still can edit');
select test.ok((public.save_day(:'admin_token', :'today'::date, 60000, 160000, :'hours'::jsonb))->>'ok' = 'true', 'admin edits locked day');
reset role;
select test.ok((select created_at < now() - interval '24 hours' from private.days where date = :'today'::date), 'admin edit does not reset the lock');
select test.ok((select count(*) = 3 from private.hours where date = :'today'::date), 'hours replaced, not duplicated');
select test.ok((select count(*) >= 4 from private.audit_log), 'changes are audited');
set role anon;

\echo '-- delete'
select test.ok((public.delete_day(:'staff_token', :'today'::date - 1))->>'ok' = 'true', 'staff deletes fresh record');
select test.ok(test.err(format('select public.delete_day(%L, %L::date - 1)', :'staff_token', :'today')) = 'not_found', 'already deleted');

\echo '-- server admin actions'
select test.ok(test.err(format('select public.delete_server(%L, %L)', :'admin_token', :'alice')) = 'server_has_hours', 'server with hours cannot be deleted');
select (public.add_server(:'staff_token', 'Carol'))->>'id' as carol \gset
select test.ok((public.delete_server(:'admin_token', :'carol'))->>'ok' = 'true', 'admin deletes unused server');
select test.ok((public.set_server_active(:'admin_token', :'bob', false))->>'active' = 'false', 'admin deactivates');
select public.set_server_order(:'admin_token', array[:'bob', :'alice']::uuid[]);
select test.ok((public.get_bootstrap(:'staff_token'))->'servers'->0->>'name' = 'Bobby', 'order changed');
select test.ok((public.update_settings(:'admin_token', 'Kai Sushi', 60, '2026-09-28'))->>'ok' = 'true', 'admin updates settings');
select test.ok(test.err(format('select public.update_settings(%L, %L, 0, %L)', :'admin_token', 'X', '2026-09-28')) = 'invalid_settings', 'bad pct rejected');

\echo '-- 3-month retention'
reset role;
insert into private.days (date, day_tips_cents, created_by, updated_by)
values ((private.today() - interval '3 months' - interval '1 day')::date, 100, 'admin', 'admin'),
	((private.today() - interval '3 months' + interval '1 day')::date, 100, 'admin', 'admin');
select private.purge();
select test.ok((select count(*) = 0 from private.days where date < private.retention_start()), 'data older than 3 months deleted');
select test.ok((select count(*) = 1 from private.days where date = (private.today() - interval '3 months' + interval '1 day')::date), 'recent data kept');
set role anon;
select test.ok(test.err(format('select public.save_day(%L, %L::date - 120, 1, null, %L::jsonb)', :'admin_token', :'today', '[]')) = 'too_old', 'cannot save older than retention');

\echo '-- brute-force throttling'
select set_config('request.headers', '{"x-forwarded-for":"10.9.9.9"}', false);
select public.login('bad1'), public.login('bad2'), public.login('bad3'), public.login('bad4'), public.login('bad5');
select test.ok((public.login('2468'))->>'error' = 'too_many_attempts', 'IP blocked after 5 failures, even with right PIN');
select set_config('request.headers', '{"x-forwarded-for":"10.8.8.8"}', false);
select test.ok((public.login('2468'))->>'ok' = 'true', 'other IP still works');
reset role;
delete from private.login_attempts;
insert into private.login_attempts (ip) select 'ip' || g from generate_series(1, 30) g;
set role anon;
select test.ok((public.login('2468'))->>'error' = 'too_many_attempts', 'global limit after 30 failures/hour');
reset role;
delete from private.login_attempts;
set role anon;

\echo '-- password changes'
select test.ok(test.err(format('select public.change_password(%L, %L, %L)', :'admin_token', 'staff', 'admin-pass-1')) = 'password_conflict', 'PIN cannot equal admin password');
select test.ok(test.err(format('select public.change_password(%L, %L, %L)', :'admin_token', 'admin', 'short')) = 'invalid_password', 'admin password min length');
select test.ok((public.change_password(:'admin_token', 'staff', '9999'))->>'ok' = 'true', 'admin changes PIN');
select test.ok(test.err(format('select public.get_bootstrap(%L)', :'staff_token')) = 'not_authenticated', 'old staff sessions logged out');
select test.ok((public.get_bootstrap(:'admin_token'))->>'role' = 'admin', 'admin stays logged in');
select test.ok((public.login('2468'))->>'error' = 'bad_password', 'old PIN no longer works');
select test.ok((public.login('9999'))->>'role' = 'staff', 'new PIN works');

\echo '-- logout'
select public.logout(:'admin_token');
select test.ok(test.err(format('select public.get_bootstrap(%L)', :'admin_token')) = 'not_authenticated', 'logged out');

reset role;
