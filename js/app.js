/*
 * Kai Calculator — UI.
 *
 * Talks to Supabase only through window.KaiApi (js/api.js). All permission
 * rules (PIN, 24h lock, admin-only actions) are enforced by the database;
 * the checks here only decide what to show.
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
	const ME_KEY = 'kai-calculator:me'; // which server "My hours" shows on this phone

	const S = {
		token: null,
		role: null,
		today: null,
		retentionStart: null,
		settings: null,
		servers: [],
		tab: 'entry',
		entryDate: null,
		reportKind: 'period',
		reportDate: null,
		mineId: null,
		mineKind: 'period',
		mineDate: null,
	};
	let lang = 'en';
	let renderSeq = 0;

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

	function money(cents) {
		return new Intl.NumberFormat(locale(), {
			style: 'currency',
			currency: 'USD',
			currencyDisplay: 'narrowSymbol',
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(cents / 100);
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

	/** A timestamp shown in the restaurant's time zone. */
	function niceTime(ts) {
		return new Intl.DateTimeFormat(locale(), {
			weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
			timeZone: S.settings ? S.settings.timezone : undefined,
		}).format(new Date(ts));
	}

	function toast(msg, kind) {
		const box = document.getElementById('toast');
		const item = el('div', { class: 'toast ' + (kind || 'ok'), role: 'status', text: msg });
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
		const msg = t(key);
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
		S.token = null;
		S.role = null;
		lsRemove(TOKEN_KEY);
	}

	async function refreshBootstrap() {
		const b = await API.rpc('get_bootstrap', { p_token: S.token });
		S.role = b.role;
		S.today = b.today;
		S.retentionStart = b.retention_start;
		S.settings = b.settings;
		S.servers = b.servers || [];
		if (!S.entryDate) {
			S.entryDate = S.today;
		}
		if (!S.reportDate) {
			S.reportDate = S.today;
		}
		if (!S.mineDate) {
			S.mineDate = S.today;
		}
	}

	async function boot() {
		lang = lsGet(LANG_KEY) || I.detect();
		document.documentElement.lang = lang;
		S.mineId = S.mineId || lsGet(ME_KEY);
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

	function renderShell() {
		const name = S.settings && S.settings.restaurant_name;
		document.title = (name ? name + ' · ' : '') + t('appTitle');
		document.getElementById('app-title').textContent = name || t('appTitle');
		const sub = document.getElementById('app-subtitle');
		sub.replaceChildren();
		appendChildren(sub, [
			S.role ? el('span', { class: 'badge ' + (isAdmin() ? 'admin' : 'on'), text: isAdmin() ? t('roleAdmin') : t('roleStaff') }) : null,
			' ' + t('appSubtitle'),
		]);
		const tabs = document.getElementById('tabs');
		if (!S.role) {
			tabs.replaceChildren();
			return;
		}
		tabs.replaceChildren.apply(tabs, [
			['entry', t('tabEntry')],
			['mine', t('tabMine')],
			['report', t('tabReport')],
			['staff', t('tabStaff')],
			['settings', t('tabSettings')],
		].map(function (tb) {
			return el('button', {
				type: 'button',
				role: 'tab',
				class: 'tab' + (S.tab === tb[0] ? ' is-on' : ''),
				'aria-selected': S.tab === tb[0] ? 'true' : 'false',
				onclick: function () {
					S.tab = tb[0];
					render();
				},
			}, tb[1]);
		}));
	}

	function render() {
		renderShell();
		const seq = ++renderSeq;
		if ('report' === S.tab) {
			renderReportTab(seq);
		} else if ('mine' === S.tab) {
			renderMineTab(seq);
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
					editUntil: d.edit_until,
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
				S.mineDate = null;
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
	/* Entry tab — one date: day tips, whole-day total, everyone's hours   */
	/* ------------------------------------------------------------------ */

	/** Why the selected date can't be edited (null = editable). */
	function lockReason(date, rec) {
		if (date > S.today) {
			return t('lockFuture');
		}
		if (S.retentionStart && date < S.retentionStart) {
			return t('lockTooOld');
		}
		if (rec) {
			return rec.editable ? null : t('lockAdminOnly', { hours: S.settings.edit_window_hours });
		}
		if (isAdmin() || date >= C.addDays(S.today, -1)) {
			return null;
		}
		return t('lockStaffOldDate');
	}

	function renderEntryTab(seq) {
		const date = S.entryDate;
		const p = C.payPeriodFor(date);
		loadRange(seq, p.from, p.to, function (range) {
			const input = calcInput(range);
			const rec = input.days.find(function (d) { return d.date === date; }) || null;
			return el('div', { class: 'stack' }, [
				renderDayForm(date, rec, input),
				renderPeriodList(p, input),
			]);
		});
	}

	function renderDayForm(date, rec, input) {
		const locked = lockReason(date, rec);
		const pct = S.settings.server_pct;
		const myHours = input.hours.filter(function (h) { return h.date === date; });
		function savedHours(serverId, shift) {
			const h = myHours.find(function (x) { return x.serverId === serverId && x.shift === shift; });
			return h ? C.formatHours(h.hundredths) : '';
		}
		const servers = S.servers.filter(function (s) {
			return s.active || myHours.some(function (h) { return h.serverId === s.id; });
		});

		const dayTipsInput = el('input', {
			id: 'day-tips', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00',
			value: rec ? C.centsToPlain(rec.dayTips) : '', disabled: !!locked, oninput: update,
		});
		const totalInput = el('input', {
			id: 'total-tips', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: t('totalPlaceholder'),
			value: rec && rec.totalTips !== null ? C.centsToPlain(rec.totalTips) : '', disabled: !!locked, oninput: update,
		});
		const nightOut = el('output', { id: 'night-tips', class: 'computed' }, '—');
		const splitOut = el('p', { class: 'split-line' });

		const inputs = {};
		const shareCells = {};
		const rows = servers.map(function (s) {
			inputs[s.id] = {};
			C.SHIFTS.forEach(function (shift) {
				inputs[s.id][shift] = el('input', {
					type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0',
					'aria-label': s.name + ' ' + t(shift) + ' ' + t('hours'),
					value: savedHours(s.id, shift), disabled: !!locked, oninput: update,
				});
			});
			shareCells[s.id] = el('td', { class: 'num share' }, '—');
			return el('tr', null, [
				el('td', { class: 'name' }, [s.name, s.active ? null : el('span', { class: 'tag', text: t('inactiveTag') })]),
				el('td', { class: 'hours-cell' }, inputs[s.id].day),
				el('td', { class: 'hours-cell' }, inputs[s.id].night),
				shareCells[s.id],
			]);
		});
		const foot = { day: el('th', { class: 'num' }, '0'), night: el('th', { class: 'num' }, '0'), share: el('th', { class: 'num' }, '—') };

		function readForm() {
			const out = { bad: [], hours: [], byShift: { day: [], night: [] } };
			const dayRaw = dayTipsInput.value.trim();
			const totalRaw = totalInput.value.trim();
			out.dayTips = dayRaw === '' ? null : C.parseMoney(dayRaw);
			out.dayTipsInvalid = dayRaw !== '' && out.dayTips === null;
			out.totalTips = totalRaw === '' ? null : C.parseMoney(totalRaw);
			out.totalInvalid = totalRaw !== '' && (out.totalTips === null || (out.dayTips !== null && out.totalTips < out.dayTips));
			dayTipsInput.classList.toggle('invalid', out.dayTipsInvalid);
			totalInput.classList.toggle('invalid', out.totalInvalid);
			servers.forEach(function (s) {
				C.SHIFTS.forEach(function (shift) {
					const field = inputs[s.id][shift];
					const raw = field.value.trim();
					const v = raw === '' ? 0 : C.parseHours(raw);
					field.classList.toggle('invalid', v === null);
					if (v === null) {
						if (out.bad.indexOf(s.name) < 0) {
							out.bad.push(s.name);
						}
					} else if (v > 0) {
						out.hours.push({ server_id: s.id, shift: shift, hundredths: v });
						out.byShift[shift].push({ key: s.id, weight: v });
					}
				});
			});
			return out;
		}

		function update() {
			const f = readForm();
			const dayTips = f.dayTips || 0;
			const night = !f.totalInvalid && f.totalTips !== null ? f.totalTips - dayTips : null;
			nightOut.textContent = night === null || night < 0 ? '—' : money(night);
			const d = C.splitShift(dayTips, pct, f.byShift.day);
			const n = C.splitShift(night && night > 0 ? night : 0, pct, f.byShift.night);
			servers.forEach(function (s) {
				const a = d.shares[s.id] || 0;
				const b = n.shares[s.id] || 0;
				shareCells[s.id].replaceChildren();
				appendChildren(shareCells[s.id], [
					a + b ? el('strong', { text: money(a + b) }) : '—',
					a && b ? el('small', { class: 'muted block', text: t('day') + ' ' + money(a) + ' · ' + t('night') + ' ' + money(b) }) : null,
				]);
			});
			foot.day.textContent = C.formatHours(f.byShift.day.reduce(function (x, e) { return x + e.weight; }, 0));
			foot.night.textContent = C.formatHours(f.byShift.night.reduce(function (x, e) { return x + e.weight; }, 0));
			foot.share.textContent = money(d.pool + n.pool);
			splitOut.textContent = t('splitLine', {
				pct: pct, kpct: 100 - pct, servers: money(d.pool + n.pool), kitchen: money(d.kitchen + n.kitchen),
			});
		}

		async function onSave(ev) {
			ev.preventDefault();
			const f = readForm();
			if (f.dayTips === null || f.dayTipsInvalid) {
				toast(t('errDayTips'), 'error');
				dayTipsInput.focus();
				return;
			}
			if (f.totalInvalid) {
				toast(t('errTotalTips'), 'error');
				totalInput.focus();
				return;
			}
			if (f.bad.length) {
				toast(t('errBadHours', { names: f.bad.join(', ') }), 'error');
				return;
			}
			if (f.dayTips > 0 && !f.byShift.day.length) {
				toast(t('errDayNoHours'), 'error');
				return;
			}
			if (f.totalTips !== null && f.totalTips - f.dayTips > 0 && !f.byShift.night.length) {
				toast(t('errNightNoHours'), 'error');
				return;
			}
			await busy(saveBtn, async function () {
				try {
					await API.rpc('save_day', {
						p_token: S.token,
						p_date: date,
						p_day_tips_cents: f.dayTips,
						p_total_tips_cents: f.totalTips,
						p_hours: f.hours,
					});
				} catch (e) {
					handleError(e);
					return;
				}
				toast(t('saved'));
				render();
			});
		}

		async function onDelete() {
			if (!window.confirm(t('confirmDeleteDay', { date: niceDate(date, true) }))) {
				return;
			}
			try {
				await API.rpc('delete_day', { p_token: S.token, p_date: date });
			} catch (e) {
				handleError(e);
				return;
			}
			toast(t('deleted'));
			render();
		}

		const saveBtn = el('button', { type: 'submit', class: 'btn primary' }, t('save'));

		let status;
		if (locked) {
			status = el('p', { class: 'notice lock', text: '🔒 ' + locked });
		} else if (rec && rec.editUntil) {
			status = el('p', { class: 'status editing', text: t('editableUntil', { time: niceTime(rec.editUntil) }) });
		} else {
			status = el('p', { class: 'status', text: rec ? t('editingExisting') : t('newRecord') });
		}

		const form = el('form', { class: 'card', onsubmit: onSave, novalidate: true }, [
			el('div', { class: 'row between' }, [
				el('h2', { text: t('entryTitle') }),
				el('div', { class: 'row date-nav' }, [
					el('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('prevDay'), onclick: function () { S.entryDate = C.addDays(date, -1); render(); } }, '‹'),
					el('input', {
						type: 'date', class: 'date-input', value: date, max: S.today, required: true, 'aria-label': t('date'),
						onchange: function (e) {
							if (C.isIsoDate(e.target.value)) {
								S.entryDate = e.target.value;
								render();
							}
						},
					}),
					el('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('nextDay'), disabled: date >= S.today, onclick: function () { S.entryDate = C.addDays(date, 1); render(); } }, '›'),
					date !== S.today ? el('button', { type: 'button', class: 'btn small', onclick: function () { S.entryDate = S.today; render(); } }, t('today')) : null,
				]),
			]),
			status,
			el('div', { class: 'tips-grid' }, [
				el('label', { class: 'field' }, [el('span', { text: '☀ ' + t('dayTips') }), dayTipsInput]),
				el('label', { class: 'field' }, [el('span', { text: t('totalTips') }), totalInput]),
				el('div', { class: 'field' }, [el('span', { text: '☾ ' + t('nightTipsAuto') }), nightOut]),
			]),
			rec && rec.totalTips === null && !locked ? el('p', { class: 'notice warn', text: t('totalMissingHint') }) : null,
			splitOut,
			servers.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'grid entry-grid' }, [
				el('thead', null, el('tr', null, [
					el('th', { text: t('server') }),
					el('th', { text: '☀ ' + t('hours') }),
					el('th', { text: '☾ ' + t('hours') }),
					el('th', { class: 'num', text: t('share') }),
				])),
				el('tbody', null, rows),
				el('tfoot', null, el('tr', null, [el('th', { text: t('total') }), foot.day, foot.night, foot.share])),
			])) : el('p', { class: 'notice warn' }, [
				t('noServersYet') + ' ',
				el('button', { type: 'button', class: 'btn small', onclick: function () { S.tab = 'staff'; render(); } }, t('goToServers')),
			]),
			el('p', { class: 'muted small', text: t('hoursHelp') }),
			locked ? null : el('div', { class: 'row actions' }, [
				saveBtn,
				rec ? el('button', { type: 'button', class: 'btn danger ghost', onclick: onDelete }, t('delete')) : null,
			]),
		]);
		update();
		return form;
	}

	function renderPeriodList(p, input) {
		const s = C.summarize(input, p.from, p.to);
		const recs = {};
		input.days.forEach(function (d) { recs[d.date] = d; });

		const body = s.days.map(function (d) {
			const rec = recs[d.date];
			return el('tr', {
				class: 'clickable' + (d.date === S.entryDate ? ' is-current' : ''),
				tabindex: '0',
				onclick: function () { S.entryDate = d.date; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
				onkeydown: function (e) { if (e.key === 'Enter') { S.entryDate = d.date; render(); } },
			}, [
				el('td', { class: 'nowrap', text: niceDate(d.date, true) }),
				el('td', { class: 'num', text: money(d.dayTips) }),
				el('td', { class: 'num', text: d.totalTips === null ? '—' : money(d.nightTips) }),
				el('td', { class: 'num strong', text: d.totalTips === null ? t('missing') : money(d.totalTips) }),
				el('td', { class: 'num', text: money(d.pool) }),
				el('td', { class: 'num', text: rec && rec.editable ? '' : '🔒' }),
			]);
		});

		return el('section', { class: 'card' }, [
			el('div', { class: 'row between' }, [
				el('h2', { text: t('periodListTitle') }),
				el('span', { class: 'muted', text: rangeLabel(p.from, p.to) }),
			]),
			s.days.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'grid' }, [
				el('thead', null, el('tr', null, [
					el('th', { text: t('date') }),
					el('th', { class: 'num', text: t('colDayTips') }),
					el('th', { class: 'num', text: t('colNightTips') }),
					el('th', { class: 'num', text: t('colTotalTips') }),
					el('th', { class: 'num', text: t('colServerPool', { pct: S.settings.server_pct }) }),
					el('th', null, ''),
				])),
				el('tbody', null, body),
				el('tfoot', null, el('tr', null, [
					el('th', { text: t('total') }),
					el('th', { class: 'num', text: money(s.totals.dayTips) }),
					el('th', { class: 'num', text: money(s.totals.nightTips) }),
					el('th', { class: 'num', text: money(s.totals.tips) }),
					el('th', { class: 'num', text: money(s.totals.pool) }),
					el('th', null, ''),
				])),
			])) : el('p', { class: 'muted', text: t('noShifts') }),
		]);
	}

	/* ------------------------------------------------------------------ */
	/* Report tab                                                          */
	/* ------------------------------------------------------------------ */

	/** Pay period (1st–15th / 16th–end) or calendar month containing `date`. */
	function rangeFor(kind, date) {
		return 'month' === kind ? C.monthRange(C.monthKey(date)) : C.payPeriodFor(date);
	}

	/** "2주 / 월" switch + ‹ range › navigation, shared by Reports and My hours. */
	function rangeControls(kind, r, onKind, onDate) {
		const isMonth = 'month' === kind;
		function move(n) {
			onDate(isMonth ? C.shiftMonth(C.monthKey(r.from), n) + '-01' : C.shiftPayPeriod(r.from, n).from);
		}
		return [
			segmented([{ value: 'period', label: t('reportPeriod') }, { value: 'month', label: t('reportMonth') }], kind, onKind),
			el('div', { class: 'row nav' }, [
				el('button', { type: 'button', class: 'btn ghost', 'aria-label': t('prev'), onclick: function () { move(-1); } }, '‹'),
				el('strong', { text: isMonth ? monthLabel(C.monthKey(r.from)) : rangeLabel(r.from, r.to) }),
				el('button', { type: 'button', class: 'btn ghost', 'aria-label': t('next'), disabled: r.to >= S.today, onclick: function () { move(1); } }, '›'),
			]),
		];
	}

	function renderReportTab(seq) {
		const r = rangeFor(S.reportKind, S.reportDate);
		const isMonth = 'month' === S.reportKind;
		loadRange(seq, r.from, r.to, function (range) {
			const s = C.summarize(calcInput(range), r.from, r.to);
			const controls = el('div', { class: 'card controls no-print' }, rangeControls(S.reportKind, r,
				function (v) { S.reportKind = v; render(); },
				function (d) { S.reportDate = d; render(); }
			).concat([
				el('div', { class: 'row wrap' }, [
					el('button', { type: 'button', class: 'btn', onclick: function () { downloadCsv(s); } }, t('downloadCsv')),
					el('button', { type: 'button', class: 'btn', onclick: function () { window.print(); } }, t('print')),
				]),
			]));
			return el('div', { class: 'stack' }, [controls, renderReportBody(s, isMonth)]);
		});
	}

	function renderReportBody(s, isMonth) {
		const tot = s.totals;
		const parts = [
			el('header', { class: 'report-head' }, [
				S.settings.restaurant_name ? el('p', { class: 'eyebrow', text: S.settings.restaurant_name }) : null,
				el('h2', { text: isMonth ? monthLabel(s.from.slice(0, 7)) : rangeLabel(s.from, s.to) }),
				isMonth ? el('p', { class: 'muted', text: rangeLabel(s.from, s.to) }) : null,
				el('p', { class: 'muted small', text: t('ruleNote', { pct: s.serverPct, kpct: 100 - s.serverPct }) }),
			]),
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
			parts.push(dayTable(s));
		}
		return el('section', { class: 'card report' }, parts);
	}

	function statCard(label, value, kind) {
		return el('div', { class: 'stat ' + kind }, [
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
				el(tag, { class: 'num muted', text: money(r.perHourCents) }),
				el(tag, { class: 'num day-col', text: C.formatHours(r.dayHours) }),
				el(tag, { class: 'num day-col', text: money(r.dayTips) }),
				el(tag, { class: 'num night-col', text: C.formatHours(r.nightHours) }),
				el(tag, { class: 'num night-col', text: money(r.nightTips) }),
			];
		}
		return el('div', { class: 'table-wrap' }, el('table', { class: 'grid report-grid' }, [
			el('thead', null, el('tr', null, [
				el('th', { text: t('server') }),
				el('th', { class: 'num', text: t('colTips') }),
				el('th', { class: 'num', text: t('colHours') }),
				el('th', { class: 'num', text: t('colPerHour') }),
				el('th', { class: 'num day-col', text: t('colDayHours') }),
				el('th', { class: 'num day-col', text: t('colDayTips') }),
				el('th', { class: 'num night-col', text: t('colNightHours') }),
				el('th', { class: 'num night-col', text: t('colNightTips') }),
			])),
			el('tbody', null, rows.map(function (r) {
				const name = r.name || t('unknownServer');
				return el('tr', null, [el('td', { class: 'name' }, r.name ? el('button', {
					type: 'button',
					class: 'link',
					title: t('openPerson', { name: name }),
					onclick: function () {
						S.mineId = r.id;
						S.mineKind = S.reportKind;
						S.mineDate = S.reportDate;
						S.tab = 'mine';
						render();
						window.scrollTo(0, 0);
					},
				}, name) : name)].concat(cells(r, 'td')));
			})),
			el('tfoot', null, el('tr', null, [el('th', { text: t('total') })].concat(cells({
				tips: tot.serverTips, hours: tot.hours, perHourCents: tot.perHourCents,
				dayHours: tot.dayHours, nightHours: tot.nightHours,
				dayTips: rows.reduce(function (a, r) { return a + r.dayTips; }, 0),
				nightTips: rows.reduce(function (a, r) { return a + r.nightTips; }, 0),
			}, 'th')))),
		]));
	}

	function dayTable(s) {
		return el('div', { class: 'table-wrap' }, el('table', { class: 'grid report-grid' }, [
			el('thead', null, el('tr', null, [
				el('th', { text: t('date') }),
				el('th', { class: 'num', text: t('colTotalTips') }),
				el('th', { class: 'num day-col', text: t('colDayTips') }),
				el('th', { class: 'num night-col', text: t('colNightTips') }),
				el('th', { class: 'num', text: t('colServerPool', { pct: s.serverPct }) }),
				el('th', { class: 'num', text: t('colKitchen', { pct: 100 - s.serverPct }) }),
				el('th', { class: 'num day-col', text: t('colDayHours') }),
				el('th', { class: 'num night-col', text: t('colNightHours') }),
			])),
			el('tbody', null, s.days.map(function (d) {
				return el('tr', null, [
					el('td', { class: 'name', text: niceDate(d.date, true) }),
					el('td', { class: 'num strong', text: d.totalTips === null ? t('missing') : money(d.totalTips) }),
					el('td', { class: 'num day-col', text: money(d.dayTips) }),
					el('td', { class: 'num night-col', text: d.totalTips === null ? '—' : money(d.nightTips) }),
					el('td', { class: 'num', text: money(d.pool) }),
					el('td', { class: 'num', text: money(d.kitchen) }),
					el('td', { class: 'num day-col', text: C.formatHours(d.dayHours) }),
					el('td', { class: 'num night-col', text: C.formatHours(d.nightHours) }),
				]);
			})),
		]));
	}

	function csvCell(v) {
		let s = String(v);
		if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) {
			s = "'" + s; // stop spreadsheet formula injection
		}
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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
			C.formatHours(s.totals.dayHours), '', C.formatHours(s.totals.nightHours), '']);
		lines.push([]);
		lines.push([t('date'), t('colTotalTips'), t('colDayTips'), t('colNightTips'),
			t('colServerPool', { pct: s.serverPct }), t('colKitchen', { pct: 100 - s.serverPct }), t('colDayHours'), t('colNightHours')]);
		s.days.forEach(function (d) {
			lines.push([d.date, d.totalTips === null ? '' : C.centsToPlain(d.totalTips), C.centsToPlain(d.dayTips),
				d.totalTips === null ? '' : C.centsToPlain(d.nightTips), C.centsToPlain(d.pool), C.centsToPlain(d.kitchen),
				C.formatHours(d.dayHours), C.formatHours(d.nightHours)]);
		});
		lines.push([t('total'), C.centsToPlain(s.totals.tips), C.centsToPlain(s.totals.dayTips), C.centsToPlain(s.totals.nightTips),
			C.centsToPlain(s.totals.pool), C.centsToPlain(s.totals.kitchen), C.formatHours(s.totals.dayHours), C.formatHours(s.totals.nightHours)]);
		const csv = '﻿' + lines.map(function (l) { return l.map(csvCell).join(','); }).join('\r\n');
		download('tips_' + s.from + '_' + s.to + '.csv', csv, 'text/csv;charset=utf-8');
	}

	/* ------------------------------------------------------------------ */
	/* My hours tab — one server's hours and tips, day by day              */
	/* ------------------------------------------------------------------ */

	function renderMineTab(seq) {
		const known = S.servers.some(function (x) { return x.id === S.mineId; });
		const id = known ? S.mineId : null;
		const picker = el('label', { class: 'field' }, [
			el('span', { text: t('pickYourName') }),
			el('select', {
				onchange: function (e) {
					S.mineId = e.target.value || null;
					if (S.mineId) {
						lsSet(ME_KEY, S.mineId);
					}
					render();
				},
			}, [el('option', { value: '', selected: !id }, '—')].concat(S.servers
				.filter(function (x) { return x.active || x.id === id; })
				.map(function (x) { return el('option', { value: x.id, selected: x.id === id }, x.name); }))),
		]);

		if (!id) {
			setMain(el('section', { class: 'card' }, [
				el('h2', { text: t('tabMine') }),
				el('p', { class: 'muted', text: S.servers.length ? t('pickYourNameHelp') : t('noServersYet') }),
				S.servers.length ? picker : null,
			]));
			return;
		}

		const r = rangeFor(S.mineKind, S.mineDate);
		const isMonth = 'month' === S.mineKind;
		const me = S.servers.find(function (x) { return x.id === id; });
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

			const controls = el('div', { class: 'card controls' }, [picker].concat(rangeControls(S.mineKind, r,
				function (v) { S.mineKind = v; render(); },
				function (d) { S.mineDate = d; render(); }
			)));

			const body = el('section', { class: 'card report' }, [
				el('header', { class: 'report-head' }, [
					el('p', { class: 'eyebrow', text: t('tabMine') }),
					el('h2', { text: me.name }),
					el('p', { class: 'muted', text: isMonth ? monthLabel(C.monthKey(r.from)) + ' · ' + rangeLabel(r.from, r.to) : rangeLabel(r.from, r.to) }),
				]),
				el('div', { class: 'cards three' }, [
					statCard(t('cardMyHours'), C.formatHours(row ? row.hours : 0), 'accent'),
					statCard(t('cardMyTips'), money(row ? row.tips : 0), ''),
					statCard(t('colPerHour'), money(row ? row.perHourCents : 0), ''),
				]),
				el('p', { class: 'muted small', text: t('mineHelp') }),
				list.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'grid report-grid mine-grid' }, [
					el('thead', null, el('tr', null, [
						el('th', { text: t('date') }),
						el('th', { class: 'num day-col', text: '☀ ' + t('hours') }),
						el('th', { class: 'num night-col', text: '☾ ' + t('hours') }),
						el('th', { class: 'num', text: t('colHours') }),
						el('th', { class: 'num', text: t('colTips') }),
					])),
					el('tbody', null, list.map(function (d) {
						return el('tr', null, [
							el('td', { class: 'name', text: niceDate(d.date, true) }),
							el('td', { class: 'num day-col', text: d.dayHours ? C.formatHours(d.dayHours) : '–' }),
							el('td', { class: 'num night-col', text: d.nightHours ? C.formatHours(d.nightHours) : '–' }),
							el('td', { class: 'num strong', text: C.formatHours(d.hours) }),
							el('td', { class: 'num', text: money(d.tips) + (missing[d.date] && d.nightHours ? ' *' : '') }),
						]);
					})),
					el('tfoot', null, el('tr', null, [
						el('th', { text: t('total') + ' (' + t('daysCount', { n: list.length }) + ')' }),
						el('th', { class: 'num day-col', text: C.formatHours(row ? row.dayHours : 0) }),
						el('th', { class: 'num night-col', text: C.formatHours(row ? row.nightHours : 0) }),
						el('th', { class: 'num', text: C.formatHours(row ? row.hours : 0) }),
						el('th', { class: 'num', text: money(row ? row.tips : 0) }),
					])),
				])) : el('p', { class: 'muted', text: t('noWorkInRange') }),
				pending ? el('p', { class: 'muted small', text: t('mineMissingTotal') }) : null,
			]);
			return el('div', { class: 'stack' }, [controls, body]);
		});
	}

	/* ------------------------------------------------------------------ */
	/* Servers tab                                                         */
	/* ------------------------------------------------------------------ */

	async function serverAction(fn, args, button) {
		return busy(button, async function () {
			try {
				await API.rpc(fn, Object.assign({ p_token: S.token }, args));
				await refreshBootstrap();
			} catch (e) {
				handleError(e);
				return false;
			}
			render();
			return true;
		});
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
			if (await serverAction('add_server', { p_name: name }, addBtn)) {
				const again = document.querySelector('.add-server input');
				if (again) {
					again.focus();
				}
			}
		}

		function move(i, d) {
			const ids = S.servers.map(function (s) { return s.id; });
			const j = i + d;
			if (j < 0 || j >= ids.length) {
				return;
			}
			const tmp = ids[i];
			ids[i] = ids[j];
			ids[j] = tmp;
			serverAction('set_server_order', { p_ids: ids });
		}

		const list = S.servers.map(function (s, i) {
			return el('li', { class: 'server-row' + (s.active ? '' : ' is-inactive') }, [
				el('input', {
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
							if (!ok) {
								e.target.value = s.name;
							}
						});
					},
				}),
				el('span', { class: 'badge ' + (s.active ? 'on' : 'off'), text: s.active ? t('active') : t('inactive') }),
				isAdmin() ? el('div', { class: 'row tight' }, [
					el('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('moveUp'), disabled: i === 0, onclick: function () { move(i, -1); } }, '↑'),
					el('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('moveDown'), disabled: i === S.servers.length - 1, onclick: function () { move(i, 1); } }, '↓'),
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

		return el('section', { class: 'card' }, [
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
			el('ul', { class: 'facts' }, [
				el('li', { text: t('factSplit', { pct: st.server_pct, kpct: 100 - st.server_pct }) }),
				el('li', { text: t('factPeriods') }),
				el('li', { text: t('factWindow', { hours: st.edit_window_hours }) }),
				el('li', { text: t('factRetention', { months: st.retention_months }) }),
				el('li', { text: t('factTimezone', { tz: st.timezone }) }),
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
			return el('div', { class: 'stack' }, parts);
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
		return el('div', { class: 'stack' }, parts);
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
		if ('visible' === document.visibilityState && S.role) {
			refreshBootstrap().catch(function (e) {
				if (e && e.code === 'not_authenticated') {
					handleError(e);
				}
			});
		}
	});

	boot();
}());
