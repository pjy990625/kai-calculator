/*
 * Kai Calculator — tiny Supabase RPC client (no library needed).
 * Every call goes to POST {supabaseUrl}/rest/v1/rpc/{function}.
 */
(function () {
	'use strict';

	const cfg = window.KAI_CONFIG || {};
	const BASE = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
	const KEY = String(cfg.supabaseKey || '').trim();
	const TIMEOUT_MS = 15000;

	// Error codes raised by supabase/setup.sql (private.fail).
	const KNOWN = [
		'not_authenticated', 'admin_only', 'invalid_date', 'future_date', 'too_old', 'locked', 'date_locked',
		'invalid_tips', 'invalid_hours', 'unknown_server', 'not_found', 'invalid_name', 'duplicate_name',
		'server_has_hours', 'invalid_settings', 'invalid_password', 'password_conflict', 'invalid_range',
	];

	class ApiError extends Error {
		constructor(code, detail) {
			super(code);
			this.code = code;
			this.detail = detail || '';
		}
	}

	function configured() {
		return /^https?:\/\/[^/]+/.test(BASE) && KEY.length > 20;
	}

	function headers() {
		const h = { 'Content-Type': 'application/json', apikey: KEY };
		// Legacy anon keys are JWTs and also go in Authorization.
		// New sb_publishable_ keys are not JWTs and must not.
		if (KEY.indexOf('eyJ') === 0) {
			h.Authorization = 'Bearer ' + KEY;
		}
		return h;
	}

	/** `opts.keepalive`: let the request finish even if the page is closed (auto-save on leaving). */
	async function rpc(fn, args, opts) {
		try {
			return await send(fn, args, opts);
		} catch (e) {
			// Let the app record unexpected errors (see the error log in app.js).
			if (typeof api.onError === 'function') {
				try {
					api.onError(e, fn);
				} catch (ignore) { /* logging must never break the call */ }
			}
			throw e;
		}
	}

	async function send(fn, args, opts) {
		// AbortController is missing on very old phones (iOS < 12.1); they just get no timeout.
		const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
		const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
		let res;
		try {
			res = await fetch(BASE + '/rest/v1/rpc/' + encodeURIComponent(fn), {
				method: 'POST',
				headers: headers(),
				body: JSON.stringify(args || {}),
				signal: ctrl ? ctrl.signal : undefined,
				cache: 'no-store',
				keepalive: !!(opts && opts.keepalive),
			});
		} catch (e) {
			throw new ApiError(e && e.name === 'AbortError' ? 'timeout' : 'network', String(e && e.message));
		} finally {
			clearTimeout(timer);
		}
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch (e) {
			body = null;
		}
		if (!res.ok) {
			const msg = body && typeof body.message === 'string' ? body.message : '';
			if (body && 'PGRST202' === body.code) {
				// The function is missing: supabase/setup.sql has not been run for this version.
				throw new ApiError('db_outdated', msg);
			}
			throw new ApiError(KNOWN.indexOf(msg) >= 0 ? msg : 'server', msg || ('HTTP ' + res.status));
		}
		return body;
	}

	const api = { configured: configured, rpc: rpc, ApiError: ApiError, onError: null };
	window.KaiApi = api;
}());
