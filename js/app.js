/*
 * Kai Calculator — UI.
 *
 * Talks to Supabase only through window.KaiApi (js/api.js). All permission
 * rules (PIN, staff can only change today's record, admin-only actions) are
 * enforced by the database; the checks here only decide what to show.
 *
 * All user-provided text is inserted with textContent (via el()), never innerHTML.
 */
(function () {
	'use strict';

	const C = window.KaiCalc;
	const I = window.KaiI18n;
	const API = window.KaiApi;
	const TOKEN_KEY = 'kai-calculator:token';
	const LANG_KEY = 'kai-calculator:lang';

	const S = {
		token: null,
		role: null,
		today: null,
		retentionStart: null,
		staffEditFrom: null, // oldest date staff can change (the database decides; 7 days)
		settings: null,
		servers: [],
		tab: 'entry',
		entryDate: null,
		entryShift: 'day', // which tab of the daily entry card is open: 'day' | 'night' | 'sum'
		entryShiftDate: null, // the date entryShift was chosen for
		unlock: null, // { date, editorId, name }: a past date opened with "Edit" (see renderDayForm)
		reportKind: 'period', // 'period' | 'month'
		reportDate: null,
		personId: null, // set: Reports shows this server's hours day by day
	};
	let lang = 'en';
	let renderSeq = 0;
	// The open entry form ({flush, leave, date, unsaved}), so leaving it can save first.
	let entryForm = null;
	const AUTOSAVE_MS = 1500;
	// Typing that can still become a valid value (see readForm in the daily entry).
	const UNFINISHED_HOURS = /^\d{0,2}(?:[.,][27]?|:[0-5]?)$/; // 2. 2.2 2.7 5: 5:4
	const UNFINISHED_MONEY = /^[\d,]*\d[.,]$/;               // 400. 400,

	/* ------------------------------------------------------------------ */
	/* Small helpers                                                       */
	/* ------------------------------------------------------------------ */

	function t(key, vars) {
		return I.t(lang, key, vars);
	}

	function lsGet(k) {
		try {
			return window.localStorage.getItem(k);
		} catch (e) {
			return null;
		}
	}

	function lsSet(k, v) {
		try {
			window.localStorage.setItem(k, v);
		} catch (e) { /* private mode: works until the tab closes */ }
	}

	function lsRemove(k) {
		try {
			window.localStorage.removeItem(k);
		} catch (e) { /* ignore */ }
	}

	/* ------------------------------------------------------------------ */
	/* Error log — unexpected errors are kept on this phone and sent to    */
	/* the database (public.log_errors). The admin sees them in Settings.  */
	/* ------------------------------------------------------------------ */

	const ERRLOG_KEY = 'kai-calculator:errors';
	const ERRLOG_KEEP = 30;
	// Not sent yet (also kept in localStorage, so a reload or no signal loses nothing).
	let errQueue = (function () {
		try {
			const saved = JSON.parse(lsGet(ERRLOG_KEY) || '[]');
			return Array.isArray(saved) ? saved : [];
		} catch (e) {
			return [];
		}
	}());
	let errTimer = null;
	let errSending = false;

	function saveErrorQueue() {
		if (errQueue.length) {
			lsSet(ERRLOG_KEY, JSON.stringify(errQueue));
		} else {
			lsRemove(ERRLOG_KEY);
		}
	}

	function logError(code, message, context) {
		errQueue.push({
			id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
			at: new Date().toISOString(),
			code: String(code || 'unknown').slice(0, 40),
			message: String(message || '').slice(0, 1000),
			context: String(context || '').slice(0, 2000),
			page: String(S.tab || ''),
			ua: String(navigator.userAgent || '').slice(0, 300),
		});
		errQueue = errQueue.slice(-ERRLOG_KEEP);
		saveErrorQueue();
		clearTimeout(errTimer);
		errTimer = setTimeout(flushErrors, 2000);
	}

	/** Send what is waiting. Quietly gives up (and tries later) when offline or logged out. */
	async function flushErrors() {
		if (errSending || !S.token || !errQueue.length) {
			return;
		}
		const batch = errQueue.slice(0, 20);
		errSending = true;
		try {
			await API.rpc('log_errors', { p_token: S.token, p_entries: batch });
		} catch (e) {
			return;
		} finally {
			errSending = false;
		}
		const sent = batch.map(function (x) { return x.id; });
		errQueue = errQueue.filter(function (x) { return sent.indexOf(x.id) < 0; });
		saveErrorQueue();
		if (errQueue.length) {
			flushErrors();
		}
	}

	API.onError = function (e, fn) {
		if ('log_errors' === fn || (e && e.expected)) {
			return; // normal answers (wrong input, locked day, …) are not problems
		}
		logError(e && e.code, e && (e.detail || e.message), 'rpc ' + fn);
	};
	window.addEventListener('error', function (ev) {
		if (!ev.message || 'Script error.' === ev.message) {
			return; // no details (e.g. a browser extension)
		}
		logError('js', ev.message, (ev.filename || '') + ':' + ev.lineno + ':' + ev.colno + (ev.error && ev.error.stack ? '\n' + ev.error.stack : ''));
	});
	window.addEventListener('unhandledrejection', function (ev) {
		const r = ev.reason;
		if (r instanceof API.ApiError) {
			return; // already recorded by API.onError
		}
		logError('js', r && r.message ? r.message : String(r), r && r.stack ? r.stack : 'unhandled promise');
	});
	window.addEventListener('online', function () { flushErrors(); });

	function el(tag, props, children) {
		const node = document.createElement(tag);
		if (props) {
			Object.keys(props).forEach(function (k) {
				const v = props[k];
				if (v === null || v === undefined || v === false) {
					return;
				}
				if (k === 'class') {
					node.className = v;
				} else if (k === 'text') {
					node.textContent = v;
				} else if (k.indexOf('on') === 0) {
					node.addEventListener(k.slice(2), v);
				} else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') {
					node[k] = v;
				} else {
					node.setAttribute(k, v === true ? '' : String(v));
				}
			});
		}
		appendChildren(node, children);
		return node;
	}

	function appendChildren(node, children) {
		if (children === null || children === undefined || children === false) {
			return;
		}
		if (Array.isArray(children)) {
			children.forEach(function (c) { appendChildren(node, c); });
		} else if (children instanceof Node) {
			node.appendChild(children);
		} else {
			node.appendChild(document.createTextNode(String(children)));
		}
	}

	function locale() {
		return 'ko' === lang ? 'ko-KR' : 'en-US';
	}

	// Formatters are slow to build and money() runs on every keystroke: one per language.
	const formatters = {};
	function formatter(name, make) {
		const key = name + ':' + lang;
		return formatters[key] || (formatters[key] = make(locale()));
	}

	/** $430 for whole dollars, $40.91 when there are cents (never $40.9). */
	function money(cents) {
		const digits = cents % 100 === 0 ? 0 : 2;
		return formatter('money' + digits, function (loc) {
			return new Intl.NumberFormat(loc, {
				style: 'currency',
				currency: 'USD',
				currencyDisplay: 'narrowSymbol',
				minimumFractionDigits: digits,
				maximumFractionDigits: digits,
			});
		}).format(cents / 100);
	}

	/** Local clock time ("9:41 PM"), with the date too when `withDate`. */
	function niceTime(date, withDate) {
		return formatter(withDate ? 'datetime' : 'time', function (loc) {
			return new Intl.DateTimeFormat(loc, withDate
				? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
				: { hour: 'numeric', minute: '2-digit' });
		}).format(date);
	}

	function roleLabel(role) {
		return 'admin' === role ? t('roleAdmin') : t('roleStaff');
	}

	function niceDate(iso, withWeekday) {
		const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
		if (withWeekday) {
			opts.weekday = 'short';
		}
		return new Intl.DateTimeFormat(locale(), opts).format(new Date(C.toUtcMs(iso)));
	}

	function rangeLabel(from, to) {
		return niceDate(from) + ' – ' + niceDate(to) + ', ' + to.slice(0, 4);
	}

	function monthLabel(ym) {
		return new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'long', timeZone: 'UTC' })
			.format(new Date(C.toUtcMs(ym + '-01')));
	}

	function toast(msg, kind) {
		const box = document.getElementById('toast');
		const item = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), role: 'status', text: msg });
		box.replaceChildren(item);
		setTimeout(function () { item.remove(); }, kind === 'error' ? 6000 : 3000);
	}

	function download(filename, content, type) {
		const url = URL.createObjectURL(new Blob([content], { type: type }));
		const a = el('a', { href: url, download: filename });
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
	}

	function segmented(options, current, onPick) {
		return el('div', { class: 'segmented', role: 'group' }, options.map(function (o) {
			return el('button', {
				type: 'button',
				class: o.value === current ? 'is-on' : '',
				'aria-pressed': o.value === current ? 'true' : 'false',
				onclick: function () { onPick(o.value); },
			}, o.label);
		}));
	}

	function errMessage(e) {
		const code = e && e.code ? e.code : 'server';
		const key = 'err_' + code;
		const msg = t(key, { months: S.settings ? S.settings.retention_months : 12 });
		return msg === key ? t('err_server') : msg;
	}

	/** Disable a button while an async action runs (prevents double saves). */
	async function busy(button, fn) {
		if (button) {
			button.disabled = true;
		}
		try {
			return await fn();
		} finally {
			if (button) {
				button.disabled = false;
			}
		}
	}

	/** Shows an API error. Returns true if the user had to log in again. */
	function handleError(e) {
		if (e && e.code === 'not_authenticated') {
			clearSession();
			renderLogin(t('sessionExpired'));
			return true;
		}
		toast(errMessage(e), 'error');
		return false;
	}

	function isAdmin() {
		return 'admin' === S.role;
	}

	/* ------------------------------------------------------------------ */
	/* Session                                                             */
	/* ------------------------------------------------------------------ */

	function clearSession() {
		entryForm = null;
		S.token = null;
		S.role = null;
		lsRemove(TOKEN_KEY);
	}

	async function refreshBootstrap() {
		const b = await API.rpc('get_bootstrap', { p_token: S.token });
		S.role = b.role;
		S.today = b.today;
		S.retentionStart = b.retention_start;
		S.staffEditFrom = b.staff_edit_from || b.today; // older database: today only
		S.settings = b.settings;
		S.servers = C.sortServers(b.servers || []); // always alphabetical
		setTimeout(flushErrors, 0); // signed in and online: send errors saved earlier
		if (!S.entryDate) {
			S.entryDate = S.today;
		}
		if (!S.reportDate) {
			S.reportDate = S.today;
		}
	}

	async function boot() {
		lang = lsGet(LANG_KEY) || I.detect();
		document.documentElement.lang = lang;
		if (!API.configured()) {
			renderSetupNeeded();
			return;
		}
		S.token = lsGet(TOKEN_KEY);
		if (!S.token) {
			renderLogin();
			return;
		}
		renderShell();
		setMain(loadingCard());
		try {
			await refreshBootstrap();
		} catch (e) {
			if (!handleError(e)) {
				setMain(errorCard(errMessage(e), boot));
			}
			return;
		}
		render();
	}

	/* ------------------------------------------------------------------ */
	/* Layout                                                              */
	/* ------------------------------------------------------------------ */

	function setMain(node) {
		const main = document.getElementById('app');
		main.replaceChildren(node);
	}

	function loadingCard() {
		return el('section', { class: 'card empty muted', 'aria-busy': 'true', text: t('loading') });
	}

	function errorCard(msg, retry) {
		return el('section', { class: 'card empty' }, [
			el('p', { class: 'notice error', text: msg }),
			retry ? el('button', { type: 'button', class: 'btn', onclick: retry }, t('retry')) : null,
		]);
	}

	/** Gear (settings) icon as inline SVG; it follows the text colour. */
	function gearIcon() {
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		[['viewBox', '0 0 24 24'], ['width', '22'], ['height', '22'], ['fill', 'none'], ['stroke', 'currentColor'],
			['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]
			.forEach(function (a) { svg.setAttribute(a[0], a[1]); });
		const circle = document.createElementNS(NS, 'circle');
		circle.setAttribute('cx', '12');
		circle.setAttribute('cy', '12');
		circle.setAttribute('r', '3');
		const path = document.createElementNS(NS, 'path');
		path.setAttribute('d', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z');
		svg.appendChild(circle);
		svg.appendChild(path);
		return svg;
	}

	/** The entry save bar sticks right under the header, whose height varies (notch, font size). */
	function syncTopbarHeight() {
		const bar = document.querySelector('.topbar');
		const h = bar && 'sticky' === window.getComputedStyle(bar).position ? bar.offsetHeight : 0;
		document.documentElement.style.setProperty('--topbar-h', h + 'px');
	}
	window.addEventListener('resize', syncTopbarHeight);

	function renderShell() {
		const name = S.settings && S.settings.restaurant_name;
		document.title = (name ? name + ' · ' : '') + t('appTitle');
		document.getElementById('app-title').textContent = name || t('appTitle');
		// Right end of the header: role badge, then the settings (gear) button.
		const actions = document.getElementById('brand-actions');
		actions.replaceChildren();
		if (S.role) {
			appendChildren(actions, [
				el('span', { class: 'badge ' + (isAdmin() ? 'admin' : 'on'), text: roleLabel(S.role) }),
				el('button', {
					type: 'button',
					class: 'icon-btn' + ('settings' === S.tab ? ' is-on' : ''),
					'aria-label': t('tabSettings'),
					title: t('tabSettings'),
					'aria-pressed': 'settings' === S.tab ? 'true' : 'false',
					onclick: function () {
						S.tab = 'settings';
						render();
					},
				}, gearIcon()),
			]);
		}
		const tabs = document.getElementById('tabs');
		if (!S.role) {
			tabs.replaceChildren();
			return;
		}
		tabs.replaceChildren.apply(tabs, [
			['entry', t('tabEntry')],
			['report', t('tabReport')],
			['staff', t('tabStaff')],
		].map(function (tb) {
			const on = S.tab === tb[0];
			return el('button', {
				type: 'button',
				role: 'tab',
				class: 'tab' + (on ? ' is-on' : ''),
				'aria-selected': on ? 'true' : 'false',
				onclick: function () {
					S.tab = tb[0];
					S.personId = null; // a tab always opens on its main view
					render();
				},
			}, tb[1]);
		}));
		syncTopbarHeight();
	}

	function render() {
		// The entry form saves what was typed before it is replaced.
		if (entryForm) {
			const form = entryForm;
			const wait = form.leave();
			if (false === wait) {
				// The user chose to stay and fix it: put the tab and date back.
				S.tab = 'entry';
				S.entryDate = form.date;
				renderShell();
				return;
			}
			entryForm = null;
			if (wait) {
				renderShell();
				wait.then(render);
				return;
			}
		}
		renderShell();
		const seq = ++renderSeq;
		if ('report' === S.tab) {
			renderReportTab(seq);
		} else if ('staff' === S.tab) {
			setMain(renderStaffTab());
		} else if ('settings' === S.tab) {
			setMain(renderSettingsTab());
		} else {
			renderEntryTab(seq);
		}
	}

	/** Load a date range, then draw with `draw(range)` unless the user moved on. */
	async function loadRange(seq, from, to, draw) {
		setMain(loadingCard());
		let range;
		try {
			range = await API.rpc('get_range', { p_token: S.token, p_from: from, p_to: to });
		} catch (e) {
			if (seq === renderSeq && !handleError(e)) {
				setMain(errorCard(errMessage(e), render));
			}
			return;
		}
		if (seq !== renderSeq) {
			return; // user switched tabs/dates while loading
		}
		S.today = range.today;
		S.retentionStart = range.retention_start;
		S.staffEditFrom = range.staff_edit_from || range.today;
		setMain(draw(range));
	}

	function calcInput(range) {
		return {
			serverPct: S.settings.server_pct,
			servers: S.servers,
			days: range.days.map(function (d) {
				return {
					date: d.date,
					dayTips: Number(d.day_tips_cents),
					totalTips: d.total_tips_cents === null ? null : Number(d.total_tips_cents),
					editable: d.editable === true,
				};
			}),
			hours: range.hours.map(function (h) {
				return { date: h.date, serverId: h.server_id, shift: h.shift, hundredths: h.hundredths };
			}),
		};
	}

	/* ------------------------------------------------------------------ */
	/* Setup / login                                                       */
	/* ------------------------------------------------------------------ */

	function renderSetupNeeded() {
		renderShell();
		setMain(el('section', { class: 'card' }, [
			el('h2', { text: t('setupTitle') }),
			el('p', { text: t('setupBody') }),
		]));
	}

	function renderLogin(message) {
		S.role = null;
		renderShell();
		const input = el('input', {
			type: 'password',
			id: 'password',
			autocomplete: 'current-password',
			required: true,
			maxlength: 200,
			'aria-label': t('password'),
		});
		const btn = el('button', { type: 'submit', class: 'btn primary block' }, t('login'));
		const note = el('p', { class: message ? 'notice warn' : 'muted small', text: message || t('loginHelp') });

		async function onSubmit(ev) {
			ev.preventDefault();
			if (!input.value) {
				input.focus();
				return;
			}
			await busy(btn, async function () {
				let r;
				try {
					r = await API.rpc('login', { p_password: input.value });
				} catch (e) {
					note.className = 'notice error';
					note.textContent = errMessage(e);
					return;
				}
				if (!r || !r.ok) {
					note.className = 'notice error';
					note.textContent = t('login_' + (r && r.error ? r.error : 'bad_password'));
					input.select();
					return;
				}
				S.token = r.token;
				lsSet(TOKEN_KEY, r.token);
				input.value = '';
				S.tab = 'entry';
				S.entryDate = null;
				S.reportDate = null;
				S.personId = null;
				boot();
			});
		}

		setMain(el('form', { class: 'card login', onsubmit: onSubmit }, [
			el('h2', { text: t('loginTitle') }),
			note,
			el('label', { class: 'field' }, [el('span', { text: t('password') }), input]),
			btn,
		]));
		setTimeout(function () { input.focus(); }, 0);
	}

	/* ------------------------------------------------------------------ */
	/* Entry tab — one date. Day tips and night tips each have their own   */
	/* tab inside the card, and each shift is saved separately.            */
	/* ------------------------------------------------------------------ */

	/** Why the selected date can't be edited (null = editable). */
	function lockReason(date, rec) {
		if (date > S.today) {
			return t('lockFuture');
		}
		if (S.retentionStart && date < S.retentionStart) {
			return t('lockTooOld', { months: S.settings.retention_months });
		}
		// Saved records: the database says. New records follow the same rule —
		// staff for 7 days (S.staffEditFrom), the admin any time.
		const editable = rec ? rec.editable : (isAdmin() || date >= S.staffEditFrom);
		return editable ? null : t('lockClosed');
	}

	/**
	 * A past day, read-only: pick who is changing it (staff share one PIN, so the
	 * audit log needs a name), confirm, and the form opens for editing.
	 */
	function unlockBox(date) {
		const admin = isAdmin();
		const who = admin ? null : el('select', { 'aria-label': t('whoEdits') }, [el('option', { value: '', text: t('pickName') })]
			.concat(S.servers.filter(function (s) { return s.active; }).map(function (s) {
				return el('option', { value: s.id, text: s.name });
			})));
		const error = el('p', { class: 'unlock-error', role: 'alert', hidden: true });
		function onEdit() {
			const id = who ? who.value : '';
			if (who && !id) {
				error.textContent = t('pickNameFirst');
				error.hidden = false;
				who.focus();
				return;
			}
			if (!window.confirm(t('confirmEditPast', { date: niceDate(date, true) }))) {
				return;
			}
			const server = S.servers.find(function (s) { return s.id === id; });
			S.unlock = { date: date, editorId: id || null, name: server ? server.name : t('roleAdmin') };
			render();
		}
		return el('div', { class: 'notice lock unlock-box' }, [
			el('p', { text: '🔒 ' + t(admin ? 'pastLockedAdmin' : 'pastLocked') }),
			el('div', { class: 'row tight' }, [
				who,
				el('button', { type: 'button', class: 'btn primary small', onclick: onEdit }, t('editPast')),
			]),
			error,
		]);
	}

	function renderEntryTab(seq) {
		const date = S.entryDate;
		loadRange(seq, date, date, function (range) {
			const input = calcInput(range);
			const rec = input.days.find(function (d) { return d.date === date; }) || null;
			return renderDayForm(date, rec, input);
		});
	}

	function renderDayForm(date, rec, input) {
		const locked = lockReason(date, rec);
		// A past day opens read-only so it can't be changed by a stray tap. "Edit" (with the
		// name of who is changing it, for the audit log) opens it until another date is picked.
		if (S.unlock && S.unlock.date !== date) {
			S.unlock = null;
		}
		const unlock = S.unlock;
		const guarded = !locked && date < S.today && !unlock;
		const readOnly = !!locked || guarded;
		const pct = S.settings.server_pct;
		const myHours = input.hours.filter(function (h) { return h.date === date; });
		function savedHours(serverId, shift) {
			const h = myHours.find(function (x) { return x.serverId === serverId && x.shift === shift; });
			return h ? C.formatHours(h.hundredths) : '';
		}
		const servers = S.servers.filter(function (s) {
			return s.active || myHours.some(function (h) { return h.serverId === s.id; });
		});

		// Which tab has been typed in and not saved yet.
		const dirty = { day: false, night: false };
		function isDirty() {
			return dirty.day || dirty.night;
		}
		function clearDirty() {
			dirty.day = false;
			dirty.night = false;
		}
		function onInput(shift) {
			return function (e) {
				dirty[shift] = true;
				edits.set(e.target, (edits.get(e.target) || 0) + 1);
				markField(e.target, 'pending');
				update();
				scheduleSave();
			};
		}

		// Each field shows its own state: amber border = typed, not saved yet;
		// green border + ✓ = saved. `edits` counts typing per field so a field
		// changed again while a save is on its way is not marked saved too early.
		const edits = new Map();
		function markField(field, state) {
			field.classList.toggle('is-pending', 'pending' === state);
			field.classList.toggle('is-saved', 'saved' === state);
		}

		const dayTipsInput = el('input', {
			id: 'day-tips', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00',
			value: rec ? C.centsToInput(rec.dayTips) : '', disabled: readOnly, oninput: onInput('day'),
		});
		const totalInput = el('input', {
			id: 'total-tips', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00',
			value: rec && rec.totalTips !== null ? C.centsToInput(rec.totalTips) : '', disabled: readOnly, oninput: onInput('night'),
		});
		const nightOut = el('output', { id: 'night-tips', class: 'computed' }, '—');
		// Shown on a saved day for as long as the whole-day total is still empty.
		const totalHint = rec && !readOnly ? el('p', { class: 'notice warn', text: t('totalMissingHint') }) : null;

		const inputs = { day: {}, night: {} };     // inputs[shift][serverId] → hours field
		const shareCells = { day: {}, night: {} }; // shareCells[shift][serverId] → tips cell
		const foot = {};
		const leftoverOut = {};
		C.SHIFTS.forEach(function (shift) {
			foot[shift] = { hours: el('th', { class: 'num' }, '0'), share: el('th', { class: 'num' }, '—') };
			leftoverOut[shift] = el('p', { class: 'split-line' });
		});

		/** One tab's table: server, hours for that shift, tips. */
		function hoursTable(shift, shareLabel) {
			if (!servers.length) {
				return el('p', { class: 'notice warn' }, [
					t('noServersYet') + ' ',
					el('button', { type: 'button', class: 'btn small', onclick: function () { S.tab = 'staff'; render(); } }, t('goToServers')),
				]);
			}
			return el('div', { class: 'table-wrap' }, el('table', { class: 'grid entry-grid' }, [
				// Fixed column widths: typing hours must never move the hours column.
				el('colgroup', null, [el('col', { class: 'col-name' }), el('col', { class: 'col-hours' }), el('col', { class: 'col-share' })]),
				el('thead', null, el('tr', null, [
					el('th', { text: t('server') }),
					el('th', { text: t('hours') }),
					el('th', { class: 'num', text: shareLabel }),
				])),
				el('tbody', null, servers.map(function (s) {
					inputs[shift][s.id] = el('input', {
						type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0',
						'aria-label': s.name + ' ' + t(shift) + ' ' + t('hours'),
						value: savedHours(s.id, shift), disabled: readOnly, oninput: onInput(shift),
					});
					shareCells[shift][s.id] = el('td', { class: 'num share' }, '—');
					return el('tr', null, [
						el('td', { class: 'name' }, [s.name, s.active ? null : el('span', { class: 'tag', text: t('inactiveTag') })]),
						el('td', { class: 'hours-cell' }, inputs[shift][s.id]),
						shareCells[shift][s.id],
					]);
				})),
				el('tfoot', null, el('tr', null, [el('th', { text: t('total') }), foot[shift].hours, foot[shift].share])),
			]));
		}

		/**
		 * The form's values. `soft` (while typing): in the field being typed in,
		 * a value that can still become right ("2." / "2.2" / "5:4" on the way to
		 * 2.25 or 5:45, "400." on the way to 400.50) is unfinished, not wrong. It
		 * is not marked red or saved, and the amounts use its whole-number part.
		 * Explicit saves (leaving a field, the date or the tab) read it as wrong.
		 */
		function readForm(soft) {
			const out = { bad: { day: [], night: [] }, hours: { day: [], night: [] }, weights: { day: [], night: [] }, typing: false };
			function raw(field, parse, unfinished) {
				const v = field.value.trim();
				if (soft && field === document.activeElement && v !== '' && parse(v) === null && unfinished.test(v)) {
					out.typing = true;
					return v.replace(/[.,:]\d?$/, '');
				}
				return v;
			}
			const dayRaw = raw(dayTipsInput, C.parseMoney, UNFINISHED_MONEY);
			const totalRaw = raw(totalInput, C.parseMoney, UNFINISHED_MONEY);
			out.dayTips = dayRaw === '' ? null : C.parseMoney(dayRaw);
			out.dayTipsInvalid = dayRaw !== '' && out.dayTips === null;
			out.totalTips = totalRaw === '' ? null : C.parseMoney(totalRaw);
			out.totalInvalid = totalRaw !== '' && (out.totalTips === null || (out.dayTips !== null && out.totalTips < out.dayTips));
			dayTipsInput.classList.toggle('invalid', out.dayTipsInvalid);
			totalInput.classList.toggle('invalid', out.totalInvalid);
			C.SHIFTS.forEach(function (shift) {
				servers.forEach(function (s) {
					const field = inputs[shift][s.id];
					const text = raw(field, C.parseHours, UNFINISHED_HOURS);
					const v = text === '' ? 0 : C.parseHours(text);
					field.classList.toggle('invalid', v === null);
					if (v === null) {
						out.bad[shift].push(s.name);
					} else if (v > 0) {
						out.hours[shift].push({ server_id: s.id, hundredths: v });
						out.weights[shift].push({ key: s.id, weight: v });
					}
				});
			});
			return out;
		}

		function update() {
			const f = readForm(true);
			C.SHIFTS.forEach(function (shift) {
				foot[shift].hours.textContent = C.formatHours(C.sumWeights(f.weights[shift]));
			});
			// Don't show amounts computed from a half-typed / wrong number.
			const dayOk = !f.dayTipsInvalid;
			const nightOk = dayOk && !f.totalInvalid;
			const dayTips = f.dayTips || 0;
			const night = f.totalTips !== null ? f.totalTips - dayTips : null;
			const d = C.splitShift(dayTips, pct, f.weights.day);
			const n = C.splitShift(night && night > 0 ? night : 0, pct, f.weights.night);

			// ☀ tab: each server's tips for the day shift.
			servers.forEach(function (s) {
				const a = d.shares[s.id] || 0;
				shareCells.day[s.id].replaceChildren(dayOk && a ? el('strong', { text: money(a) }) : '—');
			});
			foot.day.share.textContent = dayOk ? money(d.paid) : '—';
			leftoverOut.day.textContent = dayOk && d.leftover > 0 ? t('leftoverLine', { amount: money(d.leftover) }) : '';

			// ☾ tab: each server's tips for the night shift (the whole day is in the Summary tab).
			nightOut.textContent = nightOk && night !== null ? money(night) : '—';
			if (totalHint) {
				totalHint.hidden = totalInput.value.trim() !== '';
			}
			servers.forEach(function (s) {
				const b = n.shares[s.id] || 0;
				shareCells.night[s.id].replaceChildren(nightOk && b ? el('strong', { text: money(b) }) : '—');
			});
			foot.night.share.textContent = nightOk ? money(n.paid) : '—';
			leftoverOut.night.textContent = nightOk && n.leftover > 0 ? t('leftoverLine', { amount: money(n.leftover) }) : '';

			drawSummary(f, dayOk, nightOk);
		}

		/** Summary tab: the whole day as typed (saved or not), like the old daily report. */
		const sumPanel = el('div', { id: 'shift-panel-sum', class: 'shift-panel', role: 'tabpanel', 'aria-labelledby': 'shift-tab-sum' });
		function drawSummary(f, dayOk, nightOk) {
			const hours = [];
			C.SHIFTS.forEach(function (shift) {
				f.hours[shift].forEach(function (h) {
					hours.push({ date: date, serverId: h.server_id, shift: shift, hundredths: h.hundredths });
				});
			});
			const s = C.summarize({
				serverPct: pct,
				servers: S.servers,
				days: [{ date: date, dayTips: dayOk ? f.dayTips || 0 : 0, totalTips: nightOk ? f.totalTips : null }],
				hours: hours,
			}, date, date);
			const tot = s.totals;
			sumPanel.replaceChildren(
				el('div', { class: 'cards' }, [
					statCard(t('cardTotalTips'), money(tot.tips), ''),
					statCard(t('cardServers', { pct: s.serverPct }), money(tot.pool), 'accent'),
					statCard(t('cardKitchen', { pct: 100 - s.serverPct }), money(tot.kitchen), ''),
					statCard(t('cardHours'), C.formatHours(tot.hours), ''),
				]),
				dailyTable(s)
			);
		}

		function firstBadHours(shift) {
			const bad = servers.find(function (s) { return inputs[shift][s.id].classList.contains('invalid'); });
			return bad ? inputs[shift][bad.id] : null;
		}

		/** The first problem in one tab ({msg, focus}), or null. `saving` = which tabs are about to be saved. */
		function problemIn(shift, f, saving) {
			if ('day' === shift) {
				if (f.dayTips === null || f.dayTipsInvalid) {
					return { msg: t('errDayTips'), focus: dayTipsInput };
				}
				if (f.bad.day.length) {
					return { msg: t('errBadHours', { names: f.bad.day.join(', ') }), focus: firstBadHours('day') };
				}
				if (f.dayTips > 0 && !f.weights.day.length) {
					return { msg: t('errDayNoHours') };
				}
				// The whole-day total (other tab) stays as saved, so day tips have to fit under it.
				if (!saving.night && f.totalTips !== null && f.totalTips < f.dayTips) {
					return { msg: t('errDayOverTotal', { total: money(f.totalTips) }), focus: dayTipsInput };
				}
				return null;
			}
			if (f.totalInvalid) {
				return { msg: t('errTotalTips'), focus: totalInput };
			}
			if (f.bad.night.length) {
				return { msg: t('errBadHours', { names: f.bad.night.join(', ') }), focus: firstBadHours('night') };
			}
			if (f.totalTips !== null && f.totalTips - (f.dayTips || 0) > 0 && !f.weights.night.length) {
				return { msg: t('errNightNoHours') };
			}
			return null;
		}

		/* Auto-save: 1.5 s after typing stops, and right away when a field is
		 * left, the date or tab changes, or the app goes to the background.
		 * Only the tabs typed in are sent; an untouched tab keeps what the
		 * database has (maybe newer, from another phone). */
		let timer = null;
		let inFlight = null;   // the save being sent
		let again = false;     // typed while a save was being sent → save once more
		let alive = true;      // false once this form is replaced
		let blocked = null;    // why the typed values can't be saved yet

		function scheduleSave() {
			clearTimeout(timer);
			timer = setTimeout(function () { saveNow(false, true); }, AUTOSAVE_MS);
			setStatus('saving');
		}

		/** The first problem in the tabs being saved, active tab first. */
		function firstProblem(f, saving) {
			const order = 'day' === S.entryShift ? ['day', 'night'] : ['night', 'day'];
			for (let i = 0; i < order.length; i++) {
				const problem = saving[order[i]] ? problemIn(order[i], f, saving) : null;
				if (problem) {
					return problem;
				}
			}
			return null;
		}

		/**
		 * Save what was typed now. Returns the save's promise, or null if nothing was sent.
		 * `soft` (auto-save while typing): wait while a field is unfinished ("2.").
		 */
		function saveNow(keepalive, soft) {
			clearTimeout(timer);
			timer = null;
			if (inFlight) {
				again = again || isDirty();
				return inFlight;
			}
			if (!isDirty()) {
				return null;
			}
			const f = readForm(soft);
			if (f.typing) {
				timer = setTimeout(function () { saveNow(false, true); }, AUTOSAVE_MS); // leaving the field saves it
				return null;
			}
			const sent = { day: dirty.day, night: dirty.night };
			const problem = firstProblem(f, sent);
			blocked = problem;
			if (problem) {
				setStatus('blocked', problem.msg);
				return null;
			}
			clearDirty();
			setStatus('saving');
			const sentEdits = new Map(edits);
			inFlight = API.rpc('save_shifts', {
				p_token: S.token,
				p_date: date,
				p_day_tips_cents: sent.day ? f.dayTips : null,
				p_day_hours: sent.day ? f.hours.day : null,
				p_total_tips_cents: sent.night ? f.totalTips : null,
				p_night_hours: sent.night ? f.hours.night : null,
				// Only for a past day (older databases don't know this argument).
				p_editor: unlock && unlock.editorId ? unlock.editorId : undefined,
			}, { keepalive: !!keepalive }).then(function () {
				actionsRow.hidden = false; // the record exists now: it can be deleted
				sentEdits.forEach(function (n, field) {
					if (edits.get(field) === n) {
						edits.delete(field);
						markField(field, 'saved');
					}
				});
				if (!isDirty()) {
					setStatus('saved');
				}
			}, function (e) {
				dirty.day = dirty.day || sent.day;
				dirty.night = dirty.night || sent.night;
				onSaveError(e);
			}).then(function () {
				inFlight = null;
				if (again && alive) {
					again = false;
					saveNow(false, true); // typed during the save: maybe still typing
				}
			});
			return inFlight;
		}

		function onSaveError(e) {
			if (e && ('locked' === e.code || 'date_locked' === e.code || 'editor_required' === e.code)) {
				// Midnight passed (staff): the day is closed, or now needs "Edit" first.
				clearDirty();
				again = false;
				toast(t('editor_required' === e.code ? 'err_editor_required' : 'err_locked'), 'error');
				if (alive) {
					refreshBootstrap().catch(function () {}).then(render);
				}
				return;
			}
			if (e && e.code === 'not_authenticated') {
				handleError(e);
				return;
			}
			if (alive) {
				setStatus('failed', errMessage(e)); // e.g. no connection, or the database needs updating
			} else {
				toast(errMessage(e), 'error'); // the form is gone: say so instead
			}
		}

		/** One save bar for both tabs; it stays in view under the header while scrolling. */
		const statusBar = el('div', { class: 'save-bar', role: 'status' });
		let statusKind = '';
		function setStatus(kind, msg) {
			if ('saving' === kind && 'saving' === statusKind) {
				return; // typing: already says "Saving…" (don't re-announce on every key)
			}
			statusKind = kind;
			let text = '';
			if ('idle' === kind) {
				text = t('autoIdle');
			} else if ('stored' === kind) {
				text = t('autoStored');
			} else if ('saving' === kind) {
				text = t('autoSaving');
			} else if ('saved' === kind) {
				text = t('autoSaved', { time: niceTime(new Date()) });
			} else if ('blocked' === kind) {
				text = t('autoBlocked', { reason: msg });
			} else if ('failed' === kind) {
				text = t('autoFailed', { reason: msg }) + ' ';
			}
			statusBar.className = 'save-bar ' + kind;
			statusBar.replaceChildren(el('span', { text: text }), 'failed' === kind
				? el('button', { type: 'button', class: 'btn small', onclick: function () { saveNow(); } }, t('retry'))
				: '');
		}

		/**
		 * Leaving this form (another date or tab). Saves what was typed first.
		 * Returns false to stay (the user chose to fix something), a promise to
		 * wait for, or null.
		 */
		function leave() {
			saveNow();
			if (blocked && isDirty() && !window.confirm(t('leaveUnsaved', { reason: blocked.msg }))) {
				dateInput.value = date;
				return false;
			}
			alive = false;
			return inFlight;
		}

		function onSubmit(ev) {
			ev.preventDefault(); // Enter / the keyboard's Go key saves now
			saveNow();
		}

		/**
		 * Staff can only change today's record, and midnight may have passed since
		 * this page was drawn. Ask the database for today's date first; if the day
		 * has closed, say so and redraw it as locked.
		 */
		async function stillOpen() {
			if (isAdmin()) {
				return true;
			}
			try {
				await refreshBootstrap();
			} catch (e) {
				handleError(e);
				return false;
			}
			if (date === S.today) {
				return true;
			}
			toast(t('err_locked'), 'error');
			render();
			return false;
		}

		async function onDelete() {
			clearTimeout(timer);
			if (!window.confirm(t('confirmDeleteDay', { date: niceDate(date, true) })) || !(await stillOpen())) {
				return;
			}
			if (inFlight) {
				await inFlight; // don't let a late save bring the record back
			}
			try {
				await API.rpc('delete_day', { p_token: S.token, p_date: date });
			} catch (e) {
				handleError(e);
				return;
			}
			clearDirty();
			toast(t('deleted'));
			render();
		}

		let dateInput = null;
		// Changes save themselves, so the only action is Delete (once there is a record).
		// Staff can change the last 7 days, but deleting a past day stays with the admin.
		const actionsRow = isAdmin() || date === S.today ? el('div', { class: 'row actions', hidden: !rec }, [
			el('button', { type: 'button', class: 'btn danger ghost', onclick: onDelete }, t('delete')),
		]) : el('div', { hidden: true });

		let status = locked ? el('p', { class: 'notice lock', text: '🔒 ' + locked }) : null;
		if (guarded) {
			status = unlockBox(date);
		} else if (unlock) {
			status = el('div', { class: 'notice edit-on row' }, [
				el('span', { text: '✏ ' + t('editingPast', { name: unlock.name }) }),
				el('button', { type: 'button', class: 'btn small', onclick: function () {
					// Save what was typed, then lock the day again.
					const r = leave();
					if (r !== false) {
						Promise.resolve(r).then(function () { S.unlock = null; render(); });
					}
				} }, t('editDone')),
			]);
		}

		// The two tabs. Both panels stay in the page (one hidden), so switching
		// tabs never throws away what was typed.
		const tabButtons = {};
		const panels = {
			day: el('div', { id: 'shift-panel-day', class: 'shift-panel', role: 'tabpanel', 'aria-labelledby': 'shift-tab-day' }, [
				el('div', { class: 'tips-grid' }, [
					el('label', { class: 'field' }, [el('span', { text: t('dayTips') }), dayTipsInput]),
				]),
				leftoverOut.day,
				hoursTable('day', t('share')),
			]),
			night: el('div', { id: 'shift-panel-night', class: 'shift-panel', role: 'tabpanel', 'aria-labelledby': 'shift-tab-night' }, [
				el('div', { class: 'tips-grid' }, [
					el('label', { class: 'field' }, [el('span', { text: t('totalTips') }), totalInput]),
					el('div', { class: 'field' }, [el('span', { text: t('nightTipsAuto') }), nightOut]),
				]),
				totalHint,
				leftoverOut.night,
				hoursTable('night', t('share')),
			]),
			sum: sumPanel,
		};
		const hoursHelp = el('p', { class: 'muted small', text: t('hoursHelp') });
		function showShift(shift) {
			S.entryShift = shift;
			TABS.forEach(function (k) {
				const on = k === shift;
				tabButtons[k].classList.toggle('is-on', on);
				tabButtons[k].setAttribute('aria-selected', on ? 'true' : 'false');
				panels[k].hidden = !on;
			});
			hoursHelp.hidden = 'sum' === shift;
		}
		const TABS = ['day', 'night', 'sum'];
		const tabLabels = { day: '☀ ' + t('dayTab'), night: '☾ ' + t('nightTab'), sum: t('summaryTab') };
		TABS.forEach(function (k) {
			tabButtons[k] = el('button', {
				type: 'button', role: 'tab', id: 'shift-tab-' + k, class: 'shift-tab ' + k, 'aria-controls': 'shift-panel-' + k,
				onclick: function () { showShift(k); },
			}, tabLabels[k]);
		});

		const picker = dayPicker(date, function (d) { S.entryDate = d; render(); });
		dateInput = picker.input;
		const form = el('form', { class: 'card narrow', onsubmit: onSubmit, novalidate: true }, [
			picker.node,
			status,
			readOnly ? null : statusBar,
			el('div', { class: 'shift-tabs', role: 'tablist', 'aria-label': t('entryTitle') }, [tabButtons.day, tabButtons.night, tabButtons.sum]),
			panels.day,
			panels.night,
			panels.sum,
			hoursHelp,
			readOnly ? null : actionsRow,
		]);
		// Leaving a field saves it right away (no need to wait 1.5 s).
		form.addEventListener('focusout', function () {
			if (timer) {
				saveNow();
			}
		});
		entryForm = readOnly ? null : {
			flush: saveNow,
			leave: leave,
			date: date,
			unsaved: isDirty, // typed but not sendable
		};
		// Opening a date picks its tab: nothing saved → Day tips; the whole day
		// saved → Summary; only the day saved → the tab that was open. Redraws
		// of the same date (e.g. coming back from another tab) keep the tab the user is on.
		if (S.entryShiftDate !== date) {
			S.entryShiftDate = date;
			if (!rec) {
				S.entryShift = 'day';
			} else if (rec.totalTips !== null) {
				S.entryShift = 'sum';
			}
		}
		showShift(S.entryShift);
		update();
		setStatus(rec ? 'stored' : 'idle');
		return form;
	}

	/**
	 * ‹ calendar › for one day plus a Today button (Daily entry). Future dates
	 * cannot be picked.
	 */
	function dayPicker(date, onPick) {
		const input = el('input', {
			type: 'date', class: 'date-input', value: date, max: S.today, required: true, 'aria-label': t('date'),
			onchange: function (e) {
				const v = e.target.value;
				if (C.isIsoDate(v) && v <= S.today) {
					onPick(v);
				} else {
					e.target.value = date; // iOS "Clear" leaves it empty
				}
			},
		});
		return {
			input: input,
			node: el('div', { class: 'row date-nav' }, [
				// ‹ date › always stay on one line; Today may drop below on narrow screens.
				el('div', { class: 'date-step' }, [
					el('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('prevDay'), onclick: function () { onPick(C.addDays(date, -1)); } }, '‹'),
					input,
					el('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('nextDay'), disabled: date >= S.today, onclick: function () { onPick(C.addDays(date, 1)); } }, '›'),
				]),
				date !== S.today ? el('button', { type: 'button', class: 'btn small', onclick: function () { onPick(S.today); } }, t('today')) : null,
			]),
		};
	}

	/* ------------------------------------------------------------------ */
	/* Report tab                                                          */
	/* ------------------------------------------------------------------ */

	/** The pay period (1st–15th / 16th–end) or calendar month containing `date`. */
	function rangeFor(kind, date) {
		return 'month' === kind ? C.monthRange(C.monthKey(date)) : C.payPeriodFor(date);
	}

	/** Period switch + ‹ range › navigation, shared by Reports and one server's view. */
	function rangeControls(kind, r, onKind, onDate) {
		const kinds = [{ value: 'period', label: t('reportPeriod') }, { value: 'month', label: t('reportMonth') }];
		const isMonth = 'month' === kind;
		function move(n) {
			onDate(isMonth ? C.shiftMonth(C.monthKey(r.from), n) + '-01' : C.shiftPayPeriod(r.from, n).from);
		}
		return [
			segmented(kinds, kind, onKind),
			el('div', { class: 'row nav' }, [
				el('button', { type: 'button', class: 'btn ghost', 'aria-label': t('prev'), onclick: function () { move(-1); } }, '‹'),
				el('strong', { text: isMonth ? monthLabel(C.monthKey(r.from)) : rangeLabel(r.from, r.to) }),
				el('button', { type: 'button', class: 'btn ghost', 'aria-label': t('next'), disabled: r.to >= S.today, onclick: function () { move(1); } }, '›'),
			]),
		];
	}

	function renderReportTab(seq) {
		if (S.personId) {
			renderPersonView(seq);
			return;
		}
		const r = rangeFor(S.reportKind, S.reportDate);
		loadRange(seq, r.from, r.to, function (range) {
			return renderReportBody(C.summarize(calcInput(range), r.from, r.to), r);
		});
	}

	/** A date in Reports → that day's Summary tab in Daily entry. */
	function openDay(date) {
		S.tab = 'entry';
		S.entryDate = date;
		S.entryShift = 'sum';
		S.entryShiftDate = date; // keep Summary (don't pick a tab for this date)
		render();
		window.scrollTo(0, 0);
	}

	/** One card: period controls, totals, notices, the tables, CSV / print. */
	function renderReportBody(s, r) {
		const tot = s.totals;
		const kind = S.reportKind;
		let title = rangeLabel(s.from, s.to);
		if ('month' === kind) {
			title = monthLabel(s.from.slice(0, 7));
		}
		const parts = [
			// The on-screen period controls are not printed, so print gets its own heading.
			el('header', { class: 'report-head print-only' }, [
				S.settings.restaurant_name ? el('p', { class: 'eyebrow', text: S.settings.restaurant_name }) : null,
				el('h2', { text: title }),
				'month' === kind ? el('p', { class: 'muted', text: rangeLabel(s.from, s.to) }) : null,
			]),
			el('div', { class: 'range-bar no-print' }, rangeControls(kind, r,
				function (v) { S.reportKind = v; render(); },
				function (d) { S.reportDate = d; render(); }
			)),
			el('div', { class: 'cards' }, [
				statCard(t('cardTotalTips'), money(tot.tips), ''),
				statCard(t('cardServers', { pct: s.serverPct }), money(tot.pool), 'accent'),
				statCard(t('cardKitchen', { pct: 100 - s.serverPct }), money(tot.kitchen), ''),
				statCard(t('cardHours'), C.formatHours(tot.hours), ''),
			]),
		];

		if (S.retentionStart && s.from < S.retentionStart) {
			parts.push(el('div', { class: 'notice warn', text: t('retentionNote', { months: S.settings.retention_months, date: niceDate(S.retentionStart) }) }));
		}
		s.warnings.forEach(function (w) {
			if ('missingTotal' === w.type && w.date === S.today) {
				return; // normal until closing: the table already shows "missing"
			}
			parts.push(el('div', {
				class: 'notice warn',
				text: 'missingTotal' === w.type
					? t('warnMissingTotal', { date: niceDate(w.date, true) })
					: t('warnNoHours', { date: niceDate(w.date, true), shift: t(w.shift), amount: money(w.cents) }),
			}));
		});

		parts.push(el('h3', { class: 'section-title', text: t('perPersonTitle') }));
		parts.push(s.rows.length ? personTable(s.rows, tot) : el('p', { class: 'muted', text: t('noData') }));
		if (s.days.length) {
			parts.push(el('h3', { class: 'section-title', text: t('perDayTitle') }));
			parts.push(el('p', { class: 'muted small no-print', text: t('perDayHelp') }));
			parts.push(dayTable(s));
		}
		parts.push(el('div', { class: 'row actions no-print' }, [
			el('button', { type: 'button', class: 'btn', onclick: function () { downloadCsv(s); } }, t('downloadCsv')),
			el('button', { type: 'button', class: 'btn', onclick: function () { window.print(); } }, t('print')),
		]));
		return el('section', { class: 'card report' }, parts);
	}

	function statCard(label, value, kind) {
		return el('div', { class: 'stat' + (kind ? ' ' + kind : '') }, [
			el('span', { class: 'stat-label', text: label }),
			el('span', { class: 'stat-value', text: value }),
		]);
	}

	function personTable(rows, tot) {
		function cells(r, tag) {
			// Most important first so it is visible on phones without scrolling.
			return [
				el(tag, { class: 'num strong', text: money(r.tips) }),
				el(tag, { class: 'num', text: C.formatHours(r.hours) }),
			];
		}
		return el('div', { class: 'table-wrap' }, el('table', { class: 'grid report-grid' }, [
			el('thead', null, el('tr', null, [
				el('th', { text: t('server') }),
				el('th', { class: 'num', text: t('colTips') }),
				el('th', { class: 'num', text: t('colHours') }),
			])),
			el('tbody', null, rows.map(function (r) {
				const name = r.name || t('unknownServer');
				return el('tr', null, [el('td', { class: 'name' }, r.name ? el('button', {
					type: 'button',
					class: 'link',
					title: t('openPerson', { name: name }),
					onclick: function () { openPerson(r.id); },
				}, name) : name)].concat(cells(r, 'td')));
			})),
			el('tfoot', null, el('tr', null, [el('th', { text: t('total') })].concat(cells({
				tips: tot.serverTips, hours: tot.hours,
			}, 'th')))),
		]));
	}

	/** Reports → one server's hours day by day, for the same range (or the period containing `date`). */
	function openPerson(id, date) {
		S.tab = 'report';
		if (date) {
			S.reportDate = date;
		}
		S.personId = id;
		render();
		window.scrollTo(0, 0);
	}

	/** Per-day totals; tapping a date opens that day's Summary in Daily entry. */
	function dayTable(s) {
		return el('div', { class: 'table-wrap' }, el('table', { class: 'grid report-grid' }, [
			el('thead', null, el('tr', null, [
				el('th', { text: t('date') }),
				el('th', { class: 'num', text: t('colTotalTips') }),
				el('th', { class: 'num day-col', text: t('colDayTips') }),
				el('th', { class: 'num night-col', text: t('colNightTips') }),
				el('th', { class: 'num', text: t('colServerPool', { pct: s.serverPct }) }),
				el('th', { class: 'num', text: t('colPerHour') }),
				el('th', { class: 'num', text: t('colKitchen', { pct: 100 - s.serverPct }) }),
				el('th', { class: 'num', text: t('colLeftover') }),
			])),
			el('tbody', null, s.days.map(function (d) {
				const label = niceDate(d.date, true);
				return el('tr', null, [
					el('td', { class: 'name' }, el('button', {
						type: 'button',
						class: 'link',
						title: t('openDay', { date: label }),
						onclick: function () { openDay(d.date); },
					}, label)),
					el('td', { class: 'num strong', text: d.totalTips === null ? t('missing') : money(d.totalTips) }),
					el('td', { class: 'num day-col', text: money(d.dayTips) }),
					el('td', { class: 'num night-col', text: d.totalTips === null ? '—' : money(d.nightTips) }),
					el('td', { class: 'num', text: money(d.pool) }),
					el('td', { class: 'num muted', text: d.perHourCents ? money(d.perHourCents) : '—' }),
					el('td', { class: 'num', text: money(d.kitchen) }),
					el('td', { class: 'num muted', text: d.leftover ? money(d.leftover) : '—' }),
				]);
			})),
		]));
	}

	/**
	 * Daily entry → Summary: one row per server who worked that day with day
	 * hours and tips, night hours and tips, and their total for the day.
	 */
	function dailyTable(s) {
		const d = s.days[0]; // missing when nothing was entered that day
		if (!d || !d.staff.length) {
			return el('p', { class: 'muted', text: t('noStaffThatDay') });
		}
		// Night tips are not final until the whole-day total is entered.
		const pending = d.totalTips === null && d.staff.some(function (x) { return x.nightHours > 0; });
		function cell(tag, hours, tips, cls, mark) {
			if (!hours) {
				return el(tag, { class: 'num muted', text: '—' });
			}
			return el(tag, { class: 'num ' + cls }, [
				el('span', { class: 'cell-hours', text: t('hoursShort', { h: C.formatHours(hours) }) }),
				el('span', { class: 'cell-money', text: money(tips) + (mark ? ' *' : '') }),
			]);
		}
		function cells(tag, x) {
			return [
				cell(tag, x.dayHours, x.dayTips, 'day-col', false),
				cell(tag, x.nightHours, x.nightTips, 'night-col', pending),
				cell(tag, x.hours, x.tips, 'strong', pending && x.nightHours > 0),
			];
		}
		const tot = s.totals;
		return el('div', null, [
			el('div', { class: 'table-wrap' }, el('table', { class: 'grid daily-grid' }, [
				el('thead', null, el('tr', null, [
					el('th', { text: t('server') }),
					el('th', { class: 'num day-col', text: t('day') }),
					el('th', { class: 'num night-col', text: t('night') }),
					el('th', { class: 'num', text: t('total') }),
				])),
				el('tbody', null, d.staff.map(function (x) {
					const name = x.name || t('unknownServer');
					return el('tr', null, [el('td', { class: 'name' }, x.name ? el('button', {
						type: 'button',
						class: 'link',
						title: t('openPerson', { name: name }),
						onclick: function () { openPerson(x.id, d.date); },
					}, name) : name)].concat(cells('td', x)));
				})),
				el('tfoot', null, el('tr', null, [
					el('th', { text: t('total') + ' (' + t(1 === d.staff.length ? 'peopleCountOne' : 'peopleCount', { n: d.staff.length }) + ')' }),
				].concat(cells('th', {
					dayHours: tot.dayHours, dayTips: tot.serverDayTips,
					nightHours: tot.nightHours, nightTips: tot.serverNightTips,
					hours: tot.hours, tips: tot.serverTips,
				})))),
			])),
			pending ? el('p', { class: 'muted small', text: t('nightNotFinal') }) : null,
		]);
	}

	function csvCell(v) {
		let s = String(v);
		if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) {
			s = "'" + s; // stop spreadsheet formula injection
		}
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	/** Rows → a CSV file Excel opens correctly (BOM for Korean text, CRLF lines). */
	function downloadCsvFile(filename, lines) {
		download(filename, '\ufeff' + lines.map(function (l) { return l.map(csvCell).join(','); }).join('\r\n'), 'text/csv;charset=utf-8');
	}

	function downloadCsv(s) {
		const lines = [];
		lines.push([s.from + ' ~ ' + s.to]);
		lines.push([t('server'), t('colTips'), t('colHours'), t('colPerHour'), t('colDayHours'), t('colDayTips'), t('colNightHours'), t('colNightTips')]);
		s.rows.forEach(function (r) {
			lines.push([r.name || t('unknownServer'), C.centsToPlain(r.tips), C.formatHours(r.hours), C.centsToPlain(r.perHourCents),
				C.formatHours(r.dayHours), C.centsToPlain(r.dayTips), C.formatHours(r.nightHours), C.centsToPlain(r.nightTips)]);
		});
		lines.push([t('total'), C.centsToPlain(s.totals.serverTips), C.formatHours(s.totals.hours), C.centsToPlain(s.totals.perHourCents),
			C.formatHours(s.totals.dayHours), C.centsToPlain(s.totals.serverDayTips),
			C.formatHours(s.totals.nightHours), C.centsToPlain(s.totals.serverNightTips)]);
		lines.push([]);
		lines.push([t('date'), t('colTotalTips'), t('colDayTips'), t('colNightTips'),
			t('colServerPool', { pct: s.serverPct }), t('colPerHour'), t('colKitchen', { pct: 100 - s.serverPct }), t('colLeftover'), t('colDayHours'), t('colNightHours')]);
		s.days.forEach(function (d) {
			lines.push([d.date, d.totalTips === null ? '' : C.centsToPlain(d.totalTips), C.centsToPlain(d.dayTips),
				d.totalTips === null ? '' : C.centsToPlain(d.nightTips), C.centsToPlain(d.pool), C.centsToPlain(d.perHourCents), C.centsToPlain(d.kitchen),
				C.centsToPlain(d.leftover), C.formatHours(d.dayHours), C.formatHours(d.nightHours)]);
		});
		lines.push([t('total'), C.centsToPlain(s.totals.tips), C.centsToPlain(s.totals.dayTips), C.centsToPlain(s.totals.nightTips),
			C.centsToPlain(s.totals.pool), C.centsToPlain(s.totals.perHourCents), C.centsToPlain(s.totals.kitchen), C.centsToPlain(s.totals.leftover), C.formatHours(s.totals.dayHours), C.formatHours(s.totals.nightHours)]);
		lines.push([]);
		lines.push([t('perDayStaffTitle')]);
		lines.push([t('date'), t('server'), t('colDayHours'), t('colDayTips'), t('colNightHours'), t('colNightTips'), t('colHours'), t('colTips')]);
		s.days.forEach(function (d) {
			d.staff.forEach(function (x) {
				lines.push([d.date, x.name || t('unknownServer'), C.formatHours(x.dayHours), C.centsToPlain(x.dayTips),
					C.formatHours(x.nightHours), C.centsToPlain(x.nightTips), C.formatHours(x.hours), C.centsToPlain(x.tips)]);
			});
		});
		downloadCsvFile('tips_' + s.from + '_' + s.to + '.csv', lines);
	}

	/* ------------------------------------------------------------------ */
	/* Reports → one server's hours and tips, day by day                   */
	/* ------------------------------------------------------------------ */

	/** Back to Reports, on the range the server's view was showing. */
	function backToReports() {
		S.personId = null;
		render();
		window.scrollTo(0, 0);
	}

	/** Reports → one server: totals and hours/tips for each day they worked. */
	function renderPersonView(seq) {
		const id = S.personId;
		if (!S.servers.some(function (x) { return x.id === id; })) {
			backToReports(); // the server was removed meanwhile
			return;
		}
		// Switch to another server without going back to Reports.
		const picker = el('label', { class: 'field inline' }, [
			el('span', { text: t('server') }),
			el('select', {
				onchange: function (e) {
					S.personId = e.target.value;
					render();
				},
			}, S.servers
				.filter(function (x) { return x.active || x.id === id; })
				.map(function (x) { return el('option', { value: x.id, selected: x.id === id }, x.name); })),
		]);

		// Uses the Reports range, so going back shows the same period.
		const kind = S.reportKind;
		const r = rangeFor(kind, S.reportDate);
		loadRange(seq, r.from, r.to, function (range) {
			const s = C.summarize(calcInput(range), r.from, r.to);
			const row = s.rows.find(function (x) { return x.id === id; });
			const list = s.serverDays[id] || [];
			const missing = {};
			s.warnings.forEach(function (w) {
				if ('missingTotal' === w.type) {
					missing[w.date] = true;
				}
			});
			const pending = list.some(function (d) { return missing[d.date] && d.nightHours > 0; });

			// One card: back, name, period, totals, then the day-by-day table.
			return el('section', { class: 'card person narrow' }, [
				el('div', { class: 'row back-row' }, el('button', { type: 'button', class: 'btn ghost', onclick: backToReports }, t('backToReports'))),
				picker,
				el('div', { class: 'range-bar' }, rangeControls(kind, r,
					function (v) { S.reportKind = v; render(); },
					function (d) { S.reportDate = d; render(); }
				)),
				el('div', { class: 'cards three' }, [
					statCard(t('colHours'), C.formatHours(row ? row.hours : 0), 'accent'),
					statCard(t('colTips'), money(row ? row.tips : 0), ''),
					statCard(t('colPerHour'), money(row ? row.perHourCents : 0), ''),
				]),
				list.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'grid report-grid' }, [
					el('thead', null, el('tr', null, [
						el('th', { text: t('date') }),
						el('th', { class: 'num', text: t('colHours') }),
						el('th', { class: 'num', text: t('colTips') }),
					])),
					el('tbody', null, list.map(function (d) {
						return el('tr', null, [
							el('td', { class: 'name', text: niceDate(d.date, true) }),
							el('td', { class: 'num strong', text: C.formatHours(d.hours) }),
							el('td', { class: 'num', text: money(d.tips) + (missing[d.date] && d.nightHours ? ' *' : '') }),
						]);
					})),
					el('tfoot', null, el('tr', null, [
						el('th', { text: t('total') + ' (' + t(1 === list.length ? 'daysCountOne' : 'daysCount', { n: list.length }) + ')' }),
						el('th', { class: 'num', text: C.formatHours(row ? row.hours : 0) }),
						el('th', { class: 'num', text: money(row ? row.tips : 0) }),
					])),
				])) : el('p', { class: 'muted', text: t('noWorkInRange') }),
				pending ? el('p', { class: 'muted small', text: t('nightNotFinal') }) : null,
			]);
		});
	}

	/* ------------------------------------------------------------------ */
	/* Servers tab                                                         */
	/* ------------------------------------------------------------------ */

	/** Runs a server change and redraws. Returns the database's answer, or false if it failed. */
	async function serverAction(fn, args, button) {
		return busy(button, async function () {
			let result;
			try {
				result = await API.rpc(fn, Object.assign({ p_token: S.token }, args));
				await refreshBootstrap();
			} catch (e) {
				handleError(e);
				return false;
			}
			render();
			return result || true;
		});
	}

	/**
	 * The list is alphabetical, so a new or renamed server lands somewhere in
	 * the middle. Scroll to that row and flash it so it is easy to find.
	 */
	function showServerRow(id) {
		const row = Array.prototype.find.call(document.querySelectorAll('.server-row'), function (li) {
			return li.getAttribute('data-server-id') === id;
		});
		if (row) {
			row.classList.add('is-new');
			row.scrollIntoView({ block: 'nearest' });
		}
	}

	function renderStaffTab() {
		const nameInput = el('input', { type: 'text', maxlength: C.MAX_NAME_LENGTH, placeholder: t('serverNamePlaceholder'), autocomplete: 'off', 'aria-label': t('serverNamePlaceholder') });
		const addBtn = el('button', { type: 'submit', class: 'btn primary' }, t('addServer'));

		async function onAdd(ev) {
			ev.preventDefault();
			const name = C.cleanName(nameInput.value);
			if (!name) {
				toast(t('err_invalid_name'), 'error');
				return;
			}
			const added = await serverAction('add_server', { p_name: name }, addBtn);
			if (added) {
				const again = document.querySelector('.add-server input');
				if (again) {
					again.focus({ preventScroll: true }); // ready for the next name
				}
				showServerRow(added.id);
			}
		}

		const list = S.servers.map(function (s) {
			return el('li', { class: 'server-row' + (s.active ? '' : ' is-inactive'), 'data-server-id': s.id }, [
				// Only the admin can change an existing name (staff can still add servers).
				!isAdmin() ? el('span', { class: 'server-name', text: s.name }) : el('input', {
					type: 'text',
					maxlength: C.MAX_NAME_LENGTH,
					value: s.name,
					'aria-label': t('serverNamePlaceholder'),
					onchange: function (e) {
						const name = C.cleanName(e.target.value);
						if (!name) {
							e.target.value = s.name;
							toast(t('err_invalid_name'), 'error');
							return;
						}
						serverAction('rename_server', { p_id: s.id, p_name: name }).then(function (ok) {
							if (ok) {
								showServerRow(s.id); // the new name may have moved it
							} else {
								e.target.value = s.name;
							}
						});
					},
				}),
				// Only inactive servers are marked; the empty span keeps the columns lined up.
				s.active ? el('span') : el('span', { class: 'badge', text: t('inactive') }),
				isAdmin() ? el('div', { class: 'row tight' }, [
					el('button', {
						type: 'button',
						class: 'btn small',
						onclick: function (e) { serverAction('set_server_active', { p_id: s.id, p_active: !s.active }, e.currentTarget); },
					}, s.active ? t('deactivate') : t('activate')),
					el('button', {
						type: 'button',
						class: 'btn small ghost danger',
						onclick: function (e) {
							if (window.confirm(t('confirmDeleteServer', { name: s.name }))) {
								serverAction('delete_server', { p_id: s.id }, e.currentTarget);
							}
						},
					}, t('delete')),
				]) : null,
			]);
		});

		return el('section', { class: 'card narrow' }, [
			el('h2', { text: t('staffTitle') }),
			el('p', { class: 'muted', text: isAdmin() ? t('staffHelpAdmin') : t('staffHelp') }),
			el('form', { class: 'row add-server', onsubmit: onAdd }, [nameInput, addBtn]),
			S.servers.length ? el('ul', { class: 'server-list' }, list) : el('p', { class: 'muted', text: t('noServersYet') }),
		]);
	}

	/* ------------------------------------------------------------------ */
	/* Settings tab                                                        */
	/* ------------------------------------------------------------------ */

	function renderSettingsTab() {
		const st = S.settings;
		const parts = [];

		parts.push(el('section', { class: 'card form' }, [
			el('h2', { text: t('settingsTitle') }),
			el('label', { class: 'field' }, [
				el('span', { text: t('language') }),
				el('select', {
					onchange: function (e) {
						lang = e.target.value;
						lsSet(LANG_KEY, lang);
						document.documentElement.lang = lang;
						render();
					},
				}, [
					el('option', { value: 'ko', selected: 'ko' === lang }, '한국어'),
					el('option', { value: 'en', selected: 'en' === lang }, 'English'),
				]),
			]),
			el('button', {
				type: 'button',
				class: 'btn',
				onclick: async function () {
					try {
						await API.rpc('logout', { p_token: S.token });
					} catch (e) { /* logging out locally is enough */ }
					clearSession();
					renderLogin();
				},
			}, t('logout')),
		]));

		if (!isAdmin()) {
			return el('div', { class: 'stack narrow' }, parts);
		}

		const nameIn = el('input', { type: 'text', maxlength: 60, value: st.restaurant_name });
		const pctIn = el('input', { type: 'number', min: 1, max: 100, step: 1, inputmode: 'numeric', value: String(st.server_pct) });
		const saveBtn = el('button', { type: 'submit', class: 'btn primary' }, t('save'));

		parts.push(el('form', {
			class: 'card form',
			onsubmit: async function (ev) {
				ev.preventDefault();
				const pct = Number(pctIn.value);
				if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
					toast(t('err_invalid_settings'), 'error');
					return;
				}
				await busy(saveBtn, async function () {
					try {
						await API.rpc('update_settings', { p_token: S.token, p_restaurant_name: nameIn.value, p_server_pct: pct, p_period_anchor: st.period_anchor });
						await refreshBootstrap();
					} catch (e) {
						handleError(e);
						return;
					}
					toast(t('saved'));
					render();
				});
			},
		}, [
			el('h2', { text: t('adminSettingsTitle') }),
			el('label', { class: 'field' }, [el('span', { text: t('restaurantName') }), nameIn]),
			el('label', { class: 'field' }, [el('span', { text: t('serverPct') }), pctIn, el('small', { class: 'muted', text: t('serverPctHelp') })]),
			saveBtn,
		]));

		parts.push(passwordForm('staff', t('changePin'), t('changePinHelp'), 4));
		parts.push(passwordForm('admin', t('changeAdminPw'), t('changeAdminPwHelp'), 8));
		parts.push(errorLogCard());
		return el('div', { class: 'stack narrow' }, parts);
	}

	/** Admin: the errors phones ran into (newest first), with CSV download and Clear. */
	function errorLogCard() {
		const body = el('div', { class: 'error-log', text: t('loading') });
		const seq = renderSeq;
		function show(list) {
			if (seq !== renderSeq) {
				return; // the user moved on
			}
			if (!list.length) {
				body.replaceChildren(el('p', { class: 'muted', text: t('errorLogEmpty') }));
				return;
			}
			const shown = list.slice(0, 50);
			body.replaceChildren(
				el('p', { class: 'muted small', text: t('errorLogCount', { n: list.length, shown: shown.length }) }),
				el('ul', { class: 'error-list' }, shown.map(function (x) {
					const when = niceTime(new Date(x.at), true);
					return el('li', null, el('details', null, [
						el('summary', null, [
							el('span', { class: 'muted', text: when + ' · ' + roleLabel(x.role) + ' · ' }),
							el('strong', { text: x.code }),
							x.message ? el('span', { text: ' — ' + x.message }) : null,
						]),
						el('pre', { text: [x.context, x.page ? 'page: ' + x.page : '', x.ua].filter(Boolean).join('\n') }),
					]));
				})),
				el('div', { class: 'row actions' }, [
					el('button', {
						type: 'button',
						class: 'btn danger ghost',
						onclick: async function (e) {
							if (!window.confirm(t('confirmClearErrors'))) {
								return;
							}
							await busy(e.currentTarget, async function () {
								try {
									await API.rpc('clear_error_log', { p_token: S.token });
								} catch (err) {
									handleError(err);
									return;
								}
								toast(t('deleted'));
								show([]);
							});
						},
					}, t('clearErrors')),
					el('button', {
						type: 'button',
						class: 'btn',
						onclick: function () {
							const lines = [['time', 'role', 'code', 'message', 'context', 'page', 'device']].concat(list.map(function (x) {
								return [x.at, x.role, x.code, x.message || '', x.context || '', x.page || '', x.ua || ''];
							}));
							downloadCsvFile('errors_' + S.today + '.csv', lines);
						},
					}, t('downloadCsv')),
				]),
			);
		}
		API.rpc('get_error_log', { p_token: S.token }).then(show, function (e) {
			if (seq === renderSeq) {
				body.replaceChildren(el('p', { class: 'notice error', text: errMessage(e) }));
			}
		});
		return el('section', { class: 'card' }, [
			el('h2', { text: t('errorLogTitle') }),
			el('p', { class: 'muted small', text: t('errorLogHelp') }),
			body,
		]);
	}

	function passwordForm(kind, title, help, min) {
		const a = el('input', { type: 'password', autocomplete: 'new-password', minlength: min, maxlength: 200, 'aria-label': t('newPassword') });
		const b = el('input', { type: 'password', autocomplete: 'new-password', minlength: min, maxlength: 200, 'aria-label': t('confirmPassword') });
		const btn = el('button', { type: 'submit', class: 'btn' }, t('change'));
		return el('form', {
			class: 'card form',
			onsubmit: async function (ev) {
				ev.preventDefault();
				if (a.value.length < min) {
					toast(t('errPasswordShort', { n: min }), 'error');
					return;
				}
				if (a.value !== b.value) {
					toast(t('errPasswordMismatch'), 'error');
					return;
				}
				await busy(btn, async function () {
					try {
						await API.rpc('change_password', { p_token: S.token, p_kind: kind, p_new_password: a.value });
					} catch (e) {
						handleError(e);
						return;
					}
					a.value = '';
					b.value = '';
					toast(t('passwordChanged'));
				});
			},
		}, [
			el('h2', { text: title }),
			el('p', { class: 'muted small', text: help }),
			el('label', { class: 'field' }, [el('span', { text: t('newPassword') }), a]),
			el('label', { class: 'field' }, [el('span', { text: t('confirmPassword') }), b]),
			btn,
		]);
	}

	/* ------------------------------------------------------------------ */
	/* Boot                                                                */
	/* ------------------------------------------------------------------ */

	// Coming back to the app (e.g. after checking the POS): refresh "today"
	// and the session silently. Never re-render here — that would wipe
	// what the user was typing.
	document.addEventListener('visibilitychange', function () {
		if ('hidden' === document.visibilityState && entryForm) {
			entryForm.flush(true); // switching apps / locking the phone: save now
		}
		if ('visible' === document.visibilityState && S.role) {
			const before = S.today;
			refreshBootstrap().then(function () {
				if (S.today !== before && !isAdmin() && 'entry' === S.tab) {
					render(); // a new day started: what was today is now a past day (locked until "Edit")
				}
			}).catch(function (e) {
				if (e && e.code === 'not_authenticated') {
					handleError(e);
				}
			});
		}
	});

	// Closing the tab or reloading: save now, and warn if something is not saved.
	window.addEventListener('pagehide', function () {
		if (entryForm) {
			entryForm.flush(true);
		}
	});
	window.addEventListener('beforeunload', function (ev) {
		if (entryForm) {
			entryForm.flush(true);
			if (entryForm.unsaved()) {
				ev.preventDefault();
				ev.returnValue = '';
			}
		}
	});

	boot();
}());
