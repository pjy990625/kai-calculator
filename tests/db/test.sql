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
select test.ok((public.get_bootstrap(:'staff_token'))->'settings'->>'retention_months' = '12', 'records kept for 1 year');
select test.ok(((public.get_bootstrap(:'staff_token'))->>'retention_start')::date = (now() at time zone 'America/Los_Angeles')::date - interval '1 year', 'retention starts 1 year back');

\echo '-- error log'
select test.ok(test.err($$select public.log_errors('nope', '[{"code":"x"}]')$$) = 'not_authenticated', 'error log needs a session');
select test.ok((public.log_errors(:'staff_token', '[{"code":"network","message":"Failed to fetch","context":"save_shifts","page":"entry","ua":"iPhone","at":"2026-10-10T20:00:00.000Z"}, 5, {"code":""}]'))->>'added' = '2', 'staff logs errors (non-objects skipped)');
select test.ok((public.log_errors(:'staff_token', (select jsonb_agg(jsonb_build_object('code', 'js', 'message', repeat('x', 5000))) from generate_series(1, 50))))->>'added' = '20', 'at most 20 per call');
select test.ok(char_length((public.get_error_log(:'admin_token'))->0->>'message') = 1000, 'long messages cut');
select test.ok(test.err(format('select public.get_error_log(%L)', :'staff_token')) = 'admin_only', 'staff cannot read the error log');
select test.ok(json_array_length(public.get_error_log(:'admin_token')) = 22, 'admin reads the error log');
select test.ok((public.get_error_log(:'admin_token'))->21->>'code' = 'network', 'oldest last, fields kept');
select test.ok((public.get_error_log(:'admin_token'))->20->>'code' = 'unknown', 'empty code becomes unknown');
select test.ok(test.err(format('select public.clear_error_log(%L)', :'staff_token')) = 'admin_only', 'staff cannot clear');
select test.ok((public.clear_error_log(:'admin_token'))->>'ok' = 'true', 'admin clears');
select test.ok(json_array_length(public.get_error_log(:'admin_token')) = 0, 'error log empty after clearing');
reset role;
insert into private.error_log (role, code) select 'staff', 'flood' from generate_series(1, 195);
set role anon;
select test.ok((public.log_errors(:'staff_token', '[{"code":"a"},{"code":"b"},{"code":"c"},{"code":"d"},{"code":"e"},{"code":"f"},{"code":"g"}]'))->>'added' = '5', 'at most 200 per hour');
select public.clear_error_log(:'admin_token');
select test.ok((public.get_bootstrap(:'staff_token'))->'settings' ->> 'staff_hash' is null, 'hashes never returned');
select (public.get_bootstrap(:'staff_token'))->>'today' as today \gset

\echo '-- servers'
select (public.add_server(:'staff_token', '  Alice  '))->>'id' as alice \gset
select (public.add_server(:'staff_token', 'Bob'))->>'id' as bob \gset
select test.ok(test.err(format('select public.add_server(%L, %L)', :'staff_token', 'ALICE')) = 'duplicate_name', 'duplicate name (case-insensitive)');
select test.ok(test.err(format('select public.add_server(%L, %L)', :'staff_token', '   ')) = 'invalid_name', 'empty name');
select test.ok(test.err(format('select public.rename_server(%L, %L, %L)', :'staff_token', :'bob', 'Bobby')) = 'admin_only', 'staff cannot rename');
select test.ok((public.rename_server(:'admin_token', :'bob', 'Bobby'))->>'name' = 'Bobby', 'admin can rename');
select test.ok(test.err(format('select public.set_server_active(%L, %L, false)', :'staff_token', :'bob')) = 'admin_only', 'staff cannot deactivate');
select test.ok(test.err(format('select public.update_settings(%L, %L, 60, %L)', :'staff_token', 'X', '2026-09-28')) = 'admin_only', 'staff cannot change settings');
select test.ok(test.err(format('select public.change_password(%L, %L, %L)', :'staff_token', 'staff', '1234')) = 'admin_only', 'staff cannot change passwords');
select test.ok((public.get_bootstrap(:'staff_token'))->'servers'->0->>'name' = 'Alice', 'name trimmed, listed by name');
select (public.add_server(:'staff_token', 'adam'))->>'id' as adam \gset
select test.ok((public.get_bootstrap(:'staff_token'))->'servers'->0->>'name' = 'adam', 'a new server takes its place by name (case-insensitive), not the end');
select test.ok((public.get_bootstrap(:'staff_token'))->'servers'->0->>'sort_order' is null, 'no manual order any more');
select test.ok(to_regprocedure('public.set_server_order(text, uuid[])') is null, 'manual ordering function removed');

\echo '-- save_shifts: day and night are saved separately'
select format('[{"server_id":"%s","hundredths":600},{"server_id":"%s","hundredths":400}]', :'alice', :'bob') as day_hours \gset
select format('[{"server_id":"%s","hundredths":500}]', :'alice') as night_hours \gset
select test.ok((public.save_shifts(:'staff_token', :'today'::date, 50000, :'day_hours'::jsonb, null, null))->>'ok' = 'true', 'staff saves the day shift (lunch)');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'total_tips_cents' is null, 'whole-day total still empty after lunch');
select test.ok(json_array_length((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'hours') = 2, 'two day-hour rows');
select test.ok((public.save_shifts(:'staff_token', :'today'::date, null, null, 150000, :'night_hours'::jsonb))->>'ok' = 'true', 'staff saves the night shift (closing)');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'day_tips_cents' = '50000', 'saving night keeps day tips');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'total_tips_cents' = '150000', 'total stored');
select test.ok(json_array_length((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'hours') = 3, 'saving night keeps day hours');
select test.ok((public.save_shifts(:'staff_token', :'today'::date, 55000, :'day_hours'::jsonb, null, null))->>'ok' = 'true', 'day shift corrected later');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'total_tips_cents' = '150000', 'saving day keeps the whole-day total');
select test.ok(json_array_length((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'hours') = 3, 'saving day keeps night hours');
select test.ok((public.save_shifts(:'staff_token', :'today'::date, 50000, :'day_hours'::jsonb, 150000, :'night_hours'::jsonb))->>'ok' = 'true', 'both shifts in one call');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, 150001, %L::jsonb, null, null)', :'staff_token', :'today', :'day_hours')) = 'invalid_tips', 'day tips above the stored total rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, null, null, 49999, %L::jsonb)', :'staff_token', :'today', '[]')) = 'invalid_tips', 'total below the stored day tips rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, null, %L::jsonb, null, null)', :'staff_token', :'today', '[]')) = 'invalid_tips', 'day shift needs day tips');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, 1, null, 2, null)', :'staff_token', :'today')) = 'invalid_hours', 'nothing to save rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, 0, %L::jsonb, null, null)', :'staff_token', :'today',
	format('[{"server_id":"%s","hundredths":2401}]', :'alice'))) = 'invalid_hours', 'over 24h rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, 0, %L::jsonb, null, null)', :'staff_token', :'today',
	format('[{"server_id":"%s","hundredths":5.5}]', :'alice'))) = 'invalid_hours', 'fractional hundredths rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, 0, %L::jsonb, null, null)', :'staff_token', :'today',
	format('[{"server_id":"%s","hundredths":100},{"server_id":"%s","hundredths":200}]', :'alice', upper(:'alice')))) = 'invalid_hours', 'same server twice in one shift rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, 0, %L::jsonb, null, null)', :'staff_token', :'today',
	'[{"server_id":"00000000-0000-0000-0000-000000000000","hundredths":100}]')) = 'unknown_server', 'unknown server rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, 0, %L::jsonb, null, null)', :'staff_token', :'today',
	'[{"server_id":"------------------------------------","hundredths":100}]')) = 'invalid_hours', 'malformed server id rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date, 0, %L::jsonb, null, null)', :'staff_token', :'today', '{"a":1}')) = 'invalid_hours', 'non-array rejected');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date + 1, 0, %L::jsonb, null, null)', :'staff_token', :'today', '[]')) = 'future_date', 'future date rejected');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'day_tips_cents' = '50000', 'rejected saves change nothing');
select test.ok(json_array_length((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'hours') = 3, 'rejected saves keep the hours');

\echo '-- save_day (old API, for phones that have not reloaded yet)'
\set hours '[{"server_id":":alice","shift":"day","hundredths":600},{"server_id":":bob","shift":"day","hundredths":400},{"server_id":":alice","shift":"night","hundredths":500}]'
select replace(replace(:'hours', ':alice', :'alice'), ':bob', :'bob') as hours \gset
select test.ok((public.save_day(:'staff_token', :'today'::date, 50000, 150000, :'hours'::jsonb))->>'ok' = 'true', 'old API still saves today');
select test.ok(json_array_length((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'hours') = 3, 'old API replaces all hours');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 500, 400, %L::jsonb)', :'staff_token', :'today', '[]')) = 'invalid_tips', 'total < day tips rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, -1, null, %L::jsonb)', :'staff_token', :'today', '[]')) = 'invalid_tips', 'negative tips rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today',
	format('[{"server_id":"%s","shift":"day","hundredths":2401}]', :'alice'))) = 'invalid_hours', 'over 24h rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today',
	format('[{"server_id":"%s","shift":"lunch","hundredths":100}]', :'alice'))) = 'invalid_hours', 'unknown shift rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today',
	format('[{"server_id":"%s","shift":"day","hundredths":100},{"server_id":"%s","shift":"day","hundredths":200}]', :'alice', :'alice'))) = 'invalid_hours', 'duplicate entries rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today', '{"a":1}')) = 'invalid_hours', 'non-array rejected');
select test.ok(test.err(format('select public.save_day(%L, %L::date, 0, null, %L::jsonb)', :'staff_token', :'today', '[1]')) = 'invalid_hours', 'non-object entry rejected');

\echo '-- get_range'
select test.ok(json_array_length((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days') = 1, 'one day');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'editable' = 'true', 'today is editable by staff');
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'edit_until' is null, 'no edit deadline timestamp any more');
select test.ok(test.err(format('select public.get_range(%L, %L::date, %L::date - 1)', :'staff_token', :'today', :'today')) = 'invalid_range', 'reversed range rejected');
select test.ok(test.err(format('select public.get_range(%L, %L::date - 200, %L::date)', :'staff_token', :'today', :'today')) = 'invalid_range', 'huge range rejected');

\echo '-- staff can only add or change TODAY (until 11:59 PM); the admin any date'
select test.ok(test.err(format('select public.save_shifts(%L, %L::date - 1, 1000, %L::jsonb, null, null)', :'staff_token', :'today', '[]')) = 'date_locked', 'staff cannot create yesterday');
select test.ok(test.err(format('select public.save_day(%L, %L::date - 1, 1000, null, %L::jsonb)', :'staff_token', :'today', '[]')) = 'date_locked', 'staff cannot create yesterday (old API)');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date - 3, 1000, %L::jsonb, null, null)', :'staff_token', :'today', '[]')) = 'date_locked', 'staff cannot back-fill 3 days ago');
select test.ok((public.save_shifts(:'admin_token', :'today'::date - 1, 1000, '[]'::jsonb, null, null))->>'ok' = 'true', 'admin can create yesterday');
select test.ok((public.save_shifts(:'admin_token', :'today'::date - 3, 1000, '[]'::jsonb, null, null))->>'ok' = 'true', 'admin can back-fill');
select test.ok(test.err(format('select public.save_shifts(%L, %L::date - 1, null, null, 2000, %L::jsonb)', :'staff_token', :'today', '[]')) = 'locked', 'staff cannot add night tips to yesterday');
select test.ok(test.err(format('select public.save_day(%L, %L::date - 1, 1, null, %L::jsonb)', :'staff_token', :'today', '[]')) = 'locked', 'staff cannot change yesterday (old API)');
select test.ok(test.err(format('select public.delete_day(%L, %L::date - 1)', :'staff_token', :'today')) = 'locked', 'staff cannot delete yesterday');
select test.ok((public.get_range(:'staff_token', :'today'::date - 1, :'today'::date - 1))->'days'->0->>'editable' = 'false', 'yesterday shown as locked to staff');
select test.ok((public.get_range(:'admin_token', :'today'::date - 1, :'today'::date - 1))->'days'->0->>'editable' = 'true', 'admin can still edit yesterday');
select test.ok((public.save_shifts(:'admin_token', :'today'::date - 1, null, null, 2000, '[]'::jsonb))->>'ok' = 'true', 'admin edits a closed day');

\echo '-- the lock follows the date, not the age of the record'
reset role;
update private.days set created_at = now() - interval '25 hours' where date = :'today'::date;
set role anon;
select test.ok((public.get_range(:'staff_token', :'today'::date, :'today'::date))->'days'->0->>'editable' = 'true', 'today stays editable however long ago it was first saved');
select test.ok((public.save_shifts(:'staff_token', :'today'::date, 60000, :'day_hours'::jsonb, 160000, :'night_hours'::jsonb))->>'ok' = 'true', 'staff edits today again');
reset role;
select test.ok((select count(*) = 3 from private.hours where date = :'today'::date), 'hours replaced, not duplicated');
select test.ok((select count(*) >= 4 from private.audit_log), 'changes are audited');
select test.ok((select count(*) = 1 from private.audit_log where action = 'create_day' and (detail ->> 'date')::date = :'today'::date), 'first save of a date is logged as create_day');
set role anon;

\echo '-- delete'
select test.ok((public.delete_day(:'admin_token', :'today'::date - 1))->>'ok' = 'true', 'admin deletes a closed day');
select test.ok(test.err(format('select public.delete_day(%L, %L::date - 1)', :'admin_token', :'today')) = 'not_found', 'already deleted');

\echo '-- server admin actions'
select test.ok(test.err(format('select public.delete_server(%L, %L)', :'admin_token', :'alice')) = 'server_has_hours', 'server with hours cannot be deleted');
select (public.add_server(:'staff_token', 'Carol'))->>'id' as carol \gset
select test.ok((public.delete_server(:'admin_token', :'carol'))->>'ok' = 'true', 'admin deletes unused server');
select test.ok((public.set_server_active(:'admin_token', :'bob', false))->>'active' = 'false', 'admin deactivates');
select test.ok((public.delete_server(:'admin_token', :'adam'))->>'ok' = 'true', 'admin deletes another unused server');
select test.ok((public.rename_server(:'admin_token', :'alice', 'Zoe'))->>'name' = 'Zoe', 'rename');
select test.ok((public.get_bootstrap(:'staff_token'))->'servers'->0->>'name' = 'Bobby', 'a renamed server moves to its new place by name');
select test.ok((public.update_settings(:'admin_token', 'Kai Sushi', 60, '2026-09-28'))->>'ok' = 'true', 'admin updates settings');
select test.ok(test.err(format('select public.update_settings(%L, %L, 0, %L)', :'admin_token', 'X', '2026-09-28')) = 'invalid_settings', 'bad pct rejected');

\echo '-- 1-year retention'
reset role;
insert into private.days (date, day_tips_cents, created_by, updated_by)
values ((private.today() - interval '1 year' - interval '1 day')::date, 100, 'admin', 'admin'),
	((private.today() - interval '1 year' + interval '1 day')::date, 100, 'admin', 'admin');
select private.purge();
select test.ok((select count(*) = 0 from private.days where date < private.retention_start()), 'data older than 1 year deleted');
select test.ok((select count(*) = 1 from private.days where date = (private.today() - interval '1 year' + interval '1 day')::date), 'recent data kept');
set role anon;
select test.ok(test.err(format('select public.save_shifts(%L, %L::date - 400, 1, %L::jsonb, null, null)', :'admin_token', :'today', '[]')) = 'too_old', 'cannot save older than retention');

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
