/*
 * Supabase connection.
 *
 * Both values are PUBLIC by design (Supabase "publishable" key) and safe to
 * commit: the database only allows the functions in supabase/setup.sql,
 * and every one of them checks the PIN / admin session itself.
 * Never put the "secret" / service_role key here.
 */
window.KAI_CONFIG = {
	supabaseUrl: 'https://czplwyojenmnlnbspaep.supabase.co',
	supabaseKey: 'sb_publishable_Nro55spEbFGFg9UXEDrdtw_alBUJyPE',
};
