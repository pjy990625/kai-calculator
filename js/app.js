/*
 * Kai Calculator — UI.
 * All user-provided text is inserted with textContent (via el()), never innerHTML.
 */
(function () {
	'use strict';

	const C = window.KaiCalc;
	const I = window.KaiI18n;
	const STORAGE_KEY = 'kai-calculator:v1';

	let data = null;
	let lang = 'en';
	let storageOk = true;
	let loadRecovered = false;

	const ui = {
		tab: 'entry',
		entryDate: C.todayIso(),
		entryType: 'day',
		reportKind: 'period',
		reportDate: C.todayIso(),
	};

	/* ------------------------------------------------------------------ */
	/* Helpers                                                             */
	/* ------------------------------------------------------------------ */

	function t(key, vars) {
		return I.t(lang, key, vars);
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

	function money(cents, currency) {
		return new Intl.NumberFormat(locale(), {
			style: 'currency',
			currency: currency || data.settings.currency,
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

	function genId(prefix) {
		return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	}

	function serverName(id) {
		const s = data.servers.find(function (x) { return x.id === id; });
		return s ? s.name : t('unknownServer');
	}

	function toast(msg, kind) {
		const box = document.getElementById('toast');
		const item = el('div', { class: 'toast ' + (kind || 'ok'), role: 'status', text: msg });
		box.replaceChildren(item); // only the latest message
		setTimeout(function () { item.remove(); }, kind === 'error' ? 6000 : 3000);
	}

	function download(filename, content, type) {
		const blob = new Blob([content], { type: type });
		const url = URL.createObjectURL(blob);
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

	/* ------------------------------------------------------------------ */
	/* Storage                                                             */
	/* ------------------------------------------------------------------ */

	function load() {
		let raw = null;
		try {
			raw = window.localStorage.getItem(STORAGE_KEY);
		} catch (e) {
			storageOk = false;
		}
		if (!raw) {
			return C.emptyData();
		}
		try {
			return C.normalizeData(JSON.parse(raw));
		} catch (e) {
			// Keep the damaged copy so nothing is lost, then start clean.
			try {
				window.localStorage.setItem(STORAGE_KEY + ':damaged:' + Date.now(), raw);
			} catch (e2) { /* ignore */ }
			loadRecovered = true;
			return C.emptyData();
		}
	}

	function save() {
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
			return true;
		} catch (e) {
			toast(t('saveFailed'), 'error');
			return false;
		}
	}

	/* ------------------------------------------------------------------ */
	/* Render root                                                         */
	/* ------------------------------------------------------------------ */

	function render() {
		const hash = window.location.hash;
		if (hash.indexOf('#r=') === 0) {
			renderShareView(hash.slice(3));
			return;
		}
		document.body.classList.remove('is-share');
		lang = data.settings.lang || I.detect();
		document.documentElement.lang = lang;
		document.title = (data.settings.restaurantName ? data.settings.restaurantName + ' · ' : '') + t('appTitle');
		document.getElementById('app-title').textContent = data.settings.restaurantName || t('appTitle');
		document.getElementById('app-subtitle').textContent = t('appSubtitle');

		const tabs = [
			['entry', t('tabEntry')],
			['report', t('tabReport')],
			['staff', t('tabStaff')],
			['settings', t('tabSettings')],
		];
		document.getElementById('tabs').replaceChildren.apply(
			document.getElementById('tabs'),
			tabs.map(function (tb) {
				return el('button', {
					type: 'button',
					role: 'tab',
					class: 'tab' + (ui.tab === tb[0] ? ' is-on' : ''),
					'aria-selected': ui.tab === tb[0] ? 'true' : 'false',
					onclick: function () { ui.tab = tb[0]; render(); },
				}, tb[1]);
			})
		);

		const notices = [];
		if (!storageOk) {
			notices.push(el('div', { class: 'notice error', text: t('storageUnavailable') }));
		}
		if (loadRecovered) {
			notices.push(el('div', { class: 'notice error', text: t('loadRecovered') }));
		}

		let body;
		if ('report' === ui.tab) {
			body = renderReportTab();
		} else if ('staff' === ui.tab) {
			body = renderStaffTab();
		} else if ('settings' === ui.tab) {
			body = renderSettingsTab();
		} else {
			body = renderEntryTab();
		}
		const main = document.getElementById('app');
		main.replaceChildren.apply(main, notices.concat([body]));
	}

	/* ------------------------------------------------------------------ */
	/* Entry tab                                                           */
	/* ------------------------------------------------------------------ */

	function findShift(date, type) {
		return data.shifts.find(function (s) { return s.date === date && s.type === type; }) || null;
	}

	function renderEntryTab() {
		if (!data.servers.length) {
			return el('section', { class: 'card empty' }, [
				el('p', { text: t('noServersYet') }),
				el('button', { type: 'button', class: 'btn primary', onclick: function () { ui.tab = 'staff'; render(); } }, t('goToServers')),
			]);
		}

		const existing = findShift(ui.entryDate, ui.entryType);
		const servers = data.servers.filter(function (s) {
			return s.active || (existing && existing.hours[s.id]);
		});

		const tipsInput = el('input', {
			id: 'tips',
			type: 'text',
			inputmode: 'decimal',
			autocomplete: 'off',
			placeholder: '0.00',
			value: existing ? C.centsToPlain(existing.tipsCents) : '',
			oninput: updatePreview,
		});

		const hourInputs = {};
		const shareCells = {};
		const rows = servers.map(function (s) {
			hourInputs[s.id] = el('input', {
				type: 'text',
				inputmode: 'decimal',
				autocomplete: 'off',
				placeholder: '0',
				'aria-label': s.name + ' ' + t('hours'),
				value: existing && existing.hours[s.id] ? C.formatHours(existing.hours[s.id]) : '',
				oninput: updatePreview,
			});
			shareCells[s.id] = el('td', { class: 'num share' }, '—');
			return el('tr', null, [
				el('td', null, [s.name, s.active ? null : el('span', { class: 'tag', text: t('inactiveTag') })]),
				el('td', { class: 'hours-cell' }, hourInputs[s.id]),
				shareCells[s.id],
			]);
		});
		const totalHoursCell = el('td', { class: 'num' }, '0');
		const totalShareCell = el('td', { class: 'num' }, '—');

		function readForm() {
			const tipsRaw = tipsInput.value.trim();
			const tips = tipsRaw === '' ? 0 : C.parseMoney(tipsRaw);
			const hours = {};
			const bad = [];
			servers.forEach(function (s) {
				const raw = hourInputs[s.id].value.trim();
				if (raw === '') {
					hourInputs[s.id].classList.remove('invalid');
					return;
				}
				const h = C.parseHours(raw);
				hourInputs[s.id].classList.toggle('invalid', h === null);
				if (h === null) {
					bad.push(s.name);
				} else if (h > 0) {
					hours[s.id] = h;
				}
			});
			tipsInput.classList.toggle('invalid', tips === null);
			return { tips: tips, hours: hours, bad: bad };
		}

		function updatePreview() {
			const f = readForm();
			const entries = servers.filter(function (s) { return f.hours[s.id]; })
				.map(function (s) { return { key: s.id, weight: f.hours[s.id] }; });
			const split = f.tips ? C.splitByWeight(f.tips, entries) : {};
			let totalH = 0;
			servers.forEach(function (s) {
				totalH += f.hours[s.id] || 0;
				shareCells[s.id].textContent = split[s.id] !== undefined ? money(split[s.id]) : '—';
			});
			totalHoursCell.textContent = C.formatHours(totalH);
			totalShareCell.textContent = f.tips && entries.length ? money(f.tips) : '—';
		}

		function onSave(ev) {
			ev.preventDefault();
			const f = readForm();
			if (f.tips === null) {
				toast(t('errBadTips'), 'error');
				tipsInput.focus();
				return;
			}
			if (f.bad.length) {
				toast(t('errBadHours', { names: f.bad.join(', ') }), 'error');
				return;
			}
			const anyHours = Object.keys(f.hours).length > 0;
			if (f.tips > 0 && !anyHours) {
				toast(t('errTipsNoHours'), 'error');
				return;
			}
			if (!f.tips && !anyHours) {
				toast(t('errNothing'), 'error');
				return;
			}
			const record = {
				id: existing ? existing.id : genId('sh_'),
				date: ui.entryDate,
				type: ui.entryType,
				tipsCents: f.tips,
				hours: f.hours,
			};
			data.shifts = data.shifts.filter(function (s) { return !(s.date === record.date && s.type === record.type); });
			data.shifts.push(record);
			data.shifts.sort(function (a, b) { return (a.date + a.type).localeCompare(b.date + b.type); });
			if (save()) {
				toast(t('saved'));
				render();
			}
		}

		function onDelete() {
			deleteShift(existing);
		}

		const form = el('form', { class: 'card', onsubmit: onSave, novalidate: true }, [
			el('h2', { text: t('entryTitle') }),
			el('p', { class: 'muted', text: t('entryHelp') }),
			el('div', { class: 'row wrap' }, [
				el('label', { class: 'field' }, [
					el('span', { text: t('date') }),
					el('input', {
						type: 'date',
						value: ui.entryDate,
						required: true,
						onchange: function (e) {
							if (C.isIsoDate(e.target.value)) {
								ui.entryDate = e.target.value;
								render();
							}
						},
					}),
				]),
				el('div', { class: 'field' }, [
					el('span', { text: t('shift') }),
					segmented([{ value: 'day', label: '☀ ' + t('day') }, { value: 'night', label: '☾ ' + t('night') }], ui.entryType, function (v) {
						ui.entryType = v;
						render();
					}),
				]),
				el('label', { class: 'field grow' }, [el('span', { text: t('shiftTips') }), tipsInput]),
			]),
			el('p', { class: 'status ' + (existing ? 'editing' : ''), text: existing ? t('editingExisting') : t('newRecord') }),
			el('div', { class: 'table-wrap' }, el('table', { class: 'grid entry-grid' }, [
				el('thead', null, el('tr', null, [
					el('th', { text: t('server') }),
					el('th', { text: t('hours') }),
					el('th', { class: 'num', text: t('share') }),
				])),
				el('tbody', null, rows),
				el('tfoot', null, el('tr', null, [el('th', { text: t('total') }), totalHoursCell, totalShareCell])),
			])),
			el('p', { class: 'muted small', text: t('hoursHelp') }),
			el('div', { class: 'row actions' }, [
				el('button', { type: 'submit', class: 'btn primary' }, t('save')),
				existing ? el('button', { type: 'button', class: 'btn danger ghost', onclick: onDelete }, t('delete')) : null,
			]),
		]);

		updatePreview();
		return el('div', { class: 'stack' }, [form, renderPeriodList()]);
	}

	function deleteShift(shift) {
		if (!shift) {
			return;
		}
		const typeLabel = t(shift.type);
		if (!window.confirm(t('confirmDeleteShift', { date: niceDate(shift.date, true), type: typeLabel }))) {
			return;
		}
		data.shifts = data.shifts.filter(function (s) { return !(s.date === shift.date && s.type === shift.type); });
		if (save()) {
			toast(t('deleted'));
			render();
		}
	}

	function renderPeriodList() {
		const p = C.periodFor(data.settings.periodAnchor, ui.entryDate);
		const shifts = data.shifts.filter(function (s) { return s.date >= p.from && s.date <= p.to; });
		let totalTips = 0;
		let totalHours = 0;

		const body = shifts.map(function (s) {
			const h = Object.keys(s.hours).reduce(function (a, id) { return a + s.hours[id]; }, 0);
			totalTips += s.tipsCents;
			totalHours += h;
			const isCurrent = s.date === ui.entryDate && s.type === ui.entryType;
			return el('tr', { class: isCurrent ? 'is-current' : '' }, [
				el('td', { text: niceDate(s.date, true) }),
				el('td', null, el('span', { class: 'badge ' + s.type, text: t(s.type) })),
				el('td', { class: 'num', text: money(s.tipsCents) }),
				el('td', { class: 'num', text: C.formatHours(h) }),
				el('td', { class: 'num muted', text: t('serversCount', { n: Object.keys(s.hours).length }) }),
				el('td', { class: 'num nowrap' }, [
					el('button', {
						type: 'button',
						class: 'btn small ghost',
						onclick: function () {
							ui.entryDate = s.date;
							ui.entryType = s.type;
							render();
							window.scrollTo({ top: 0, behavior: 'smooth' });
						},
					}, t('edit')),
					el('button', { type: 'button', class: 'btn small ghost danger', onclick: function () { deleteShift(s); } }, t('delete')),
				]),
			]);
		});

		return el('section', { class: 'card' }, [
			el('div', { class: 'row between' }, [
				el('h2', { text: t('periodListTitle') }),
				el('span', { class: 'muted', text: rangeLabel(p.from, p.to) }),
			]),
			shifts.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'grid' }, [
				el('thead', null, el('tr', null, [
					el('th', { text: t('date') }),
					el('th', { text: t('shift') }),
					el('th', { class: 'num', text: t('tips') }),
					el('th', { class: 'num', text: t('hours') }),
					el('th', null, ''),
					el('th', null, ''),
				])),
				el('tbody', null, body),
				el('tfoot', null, el('tr', null, [
					el('th', { text: t('total') }),
					el('th', null, ''),
					el('th', { class: 'num', text: money(totalTips) }),
					el('th', { class: 'num', text: C.formatHours(totalHours) }),
					el('th', null, ''),
					el('th', null, ''),
				])),
			])) : el('p', { class: 'muted', text: t('noShifts') }),
		]);
	}

	/* ------------------------------------------------------------------ */
	/* Report tab                                                          */
	/* ------------------------------------------------------------------ */

	function currentReportRange() {
		if ('month' === ui.reportKind) {
			return C.monthRange(C.monthKey(ui.reportDate));
		}
		return C.periodFor(data.settings.periodAnchor, ui.reportDate);
	}

	function buildView() {
		const r = currentReportRange();
		const s = C.summarize(data, r.from, r.to);
		const view = {
			title: data.settings.restaurantName,
			currency: data.settings.currency,
			lang: lang,
			kind: ui.reportKind,
			mode: data.settings.splitMode,
			from: r.from,
			to: r.to,
			generatedAt: new Date().toISOString(),
			rows: s.rows.map(function (row) {
				return Object.assign({}, row, { name: row.name || t('unknownServer') });
			}),
			totals: s.totals,
			unallocatedCents: s.unallocatedCents,
			sections: [],
		};
		if ('month' === ui.reportKind) {
			view.sections = C.periodsInRange(data.settings.periodAnchor, r.from, r.to).map(function (p) {
				const ps = C.summarize(data, p.from, p.to);
				return {
					from: p.from,
					to: p.to,
					fullFrom: p.fullFrom,
					fullTo: p.fullTo,
					partial: p.partial,
					rows: ps.rows.map(function (row) { return Object.assign({}, row, { name: row.name || t('unknownServer') }); }),
					totals: ps.totals,
					unallocatedCents: ps.unallocatedCents,
				};
			});
		}
		return view;
	}

	function renderReportTab() {
		const view = buildView();
		const isMonth = 'month' === ui.reportKind;

		function move(n) {
			if (isMonth) {
				ui.reportDate = C.shiftMonth(C.monthKey(ui.reportDate), n) + '-01';
			} else {
				ui.reportDate = C.addDays(view.from, n * C.PERIOD_DAYS);
			}
			render();
		}

		const controls = el('div', { class: 'card controls no-print' }, [
			segmented([{ value: 'period', label: t('reportPeriod') }, { value: 'month', label: t('reportMonth') }], ui.reportKind, function (v) {
				ui.reportKind = v;
				render();
			}),
			el('div', { class: 'row nav' }, [
				el('button', { type: 'button', class: 'btn ghost', 'aria-label': t('prev'), onclick: function () { move(-1); } }, '‹'),
				el('strong', { text: isMonth ? monthLabel(C.monthKey(view.from)) : rangeLabel(view.from, view.to) }),
				el('button', { type: 'button', class: 'btn ghost', 'aria-label': t('next'), onclick: function () { move(1); } }, '›'),
			]),
			el('div', { class: 'row wrap' }, [
				el('button', { type: 'button', class: 'btn primary', onclick: function () { copyShareLink(view); } }, t('shareLink')),
				el('button', { type: 'button', class: 'btn', onclick: function () { downloadCsv(view); } }, t('downloadCsv')),
				el('button', { type: 'button', class: 'btn', onclick: function () { window.print(); } }, t('print')),
			]),
		]);

		return el('div', { class: 'stack' }, [controls, renderReportBody(view)]);
	}

	/** Shared by the Reports tab and the read-only share view. */
	function renderReportBody(view) {
		const heading = 'month' === view.kind ? monthLabel(view.from.slice(0, 7)) : rangeLabel(view.from, view.to);
		const tot = view.totals;

		const parts = [
			el('header', { class: 'report-head' }, [
				view.title ? el('p', { class: 'eyebrow', text: view.title }) : null,
				el('h2', { text: heading }),
				'month' === view.kind ? el('p', { class: 'muted', text: rangeLabel(view.from, view.to) }) : null,
				el('p', { class: 'muted small', text: t('perShift' === view.mode ? 'modePerShiftNote' : 'modePooledNote') }),
			]),
			el('div', { class: 'cards' }, [
				statCard(t('cardTotalTips'), money(tot.tips, view.currency), 'accent'),
				statCard(t('cardDayTips'), money(tot.dayTips, view.currency), 'day'),
				statCard(t('cardNightTips'), money(tot.nightTips, view.currency), 'night'),
				statCard(t('cardHours'), C.formatHours(tot.hours)),
			]),
		];

		if (view.unallocatedCents > 0) {
			parts.push(el('div', { class: 'notice warn', text: t('unallocatedWarn', { amount: money(view.unallocatedCents, view.currency) }) }));
		}
		parts.push(view.rows.length ? reportTable(view.rows, tot, view.currency) : el('p', { class: 'muted', text: t('noData') }));

		if (view.sections && view.sections.length > 1) {
			parts.push(el('h3', { class: 'section-title', text: t('breakdownTitle') }));
			view.sections.forEach(function (s) {
				parts.push(el('div', { class: 'sub-report' }, [
					el('div', { class: 'row between' }, [
						el('h4', { text: rangeLabel(s.from, s.to) }),
						el('span', { class: 'muted', text: money(s.totals.tips, view.currency) }),
					]),
					s.partial && s.fullFrom ? el('p', { class: 'muted small', text: t('partialPeriod', { from: niceDate(s.fullFrom), to: niceDate(s.fullTo) }) }) : null,
					s.unallocatedCents > 0 ? el('div', { class: 'notice warn', text: t('unallocatedWarn', { amount: money(s.unallocatedCents, view.currency) }) }) : null,
					s.rows.length ? reportTable(s.rows, s.totals, view.currency) : el('p', { class: 'muted', text: t('noData') }),
				]));
			});
		}

		if (view.generatedAt) {
			const d = new Date(view.generatedAt);
			if (!isNaN(d.getTime())) {
				parts.push(el('p', { class: 'muted small generated', text: t('generatedAt', {
					date: new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(d),
				}) }));
			}
		}
		return el('section', { class: 'card report' }, parts);
	}

	function statCard(label, value, kind) {
		return el('div', { class: 'stat ' + (kind || '') }, [
			el('span', { class: 'stat-label', text: label }),
			el('span', { class: 'stat-value', text: value }),
		]);
	}

	function reportTable(rows, tot, currency) {
		function cells(r, tag) {
			// Most important first so it is visible on phones without scrolling.
			return [
				el(tag, { class: 'num strong', text: money(r.tips, currency) }),
				el(tag, { class: 'num', text: C.formatHours(r.hours) }),
				el(tag, { class: 'num muted', text: money(r.perHourCents, currency) }),
				el(tag, { class: 'num day-col', text: C.formatHours(r.dayHours) }),
				el(tag, { class: 'num day-col', text: money(r.dayTips, currency) }),
				el(tag, { class: 'num night-col', text: C.formatHours(r.nightHours) }),
				el(tag, { class: 'num night-col', text: money(r.nightTips, currency) }),
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
				return el('tr', null, [el('td', { class: 'name', text: r.name || t('unknownServer') })].concat(cells(r, 'td')));
			})),
			el('tfoot', null, el('tr', null, [el('th', { text: t('total') })].concat(cells(tot, 'th')))),
		]));
	}

	function shareUrl(view) {
		const base = window.location.href.split('#')[0];
		return base + '#r=' + C.encodeShare(C.buildSharePayload(view));
	}

	function copyShareLink(view) {
		const url = shareUrl(view);
		function fallback() {
			window.prompt(t('copyManually'), url);
		}
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(url).then(function () { toast(t('linkCopied')); }, fallback);
		} else {
			fallback();
		}
	}

	function csvCell(v) {
		let s = String(v);
		if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) {
			s = "'" + s; // stop spreadsheet formula injection
		}
		return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
	}

	function downloadCsv(view) {
		const head = [t('server'), t('colTips'), t('colHours'), t('colPerHour'), t('colDayHours'), t('colDayTips'), t('colNightHours'), t('colNightTips')];
		function cols(r) {
			return [C.centsToPlain(r.tips), C.formatHours(r.hours), C.centsToPlain(r.perHourCents),
				C.formatHours(r.dayHours), C.centsToPlain(r.dayTips), C.formatHours(r.nightHours), C.centsToPlain(r.nightTips)];
		}
		const lines = [];
		function block(title, rows, tot) {
			lines.push([title]);
			lines.push(head);
			rows.forEach(function (r) {
				lines.push([r.name].concat(cols(r)));
			});
			lines.push([t('total')].concat(cols(tot)));
			lines.push([]);
		}
		block(view.from + ' ~ ' + view.to, view.rows, view.totals);
		if (view.sections.length > 1) {
			view.sections.forEach(function (s) { block(s.from + ' ~ ' + s.to, s.rows, s.totals); });
		}
		const csv = '﻿' + lines.map(function (l) { return l.map(csvCell).join(','); }).join('\r\n');
		download('tips_' + view.from + '_' + view.to + '.csv', csv, 'text/csv;charset=utf-8');
	}

	/* ------------------------------------------------------------------ */
	/* Share view (read-only, from #r=...)                                 */
	/* ------------------------------------------------------------------ */

	function renderShareView(encoded) {
		let view = null;
		try {
			view = C.viewFromSharePayload(C.decodeShare(encoded));
		} catch (e) {
			view = null;
		}
		lang = view ? view.lang : (data.settings.lang || I.detect());
		document.documentElement.lang = lang;
		document.body.classList.add('is-share');
		document.getElementById('app-title').textContent = (view && view.title) || t('appTitle');
		document.getElementById('app-subtitle').textContent = t('shareBanner');
		document.title = ((view && view.title) ? view.title + ' · ' : '') + t('appTitle');
		const tabs = document.getElementById('tabs');
		tabs.replaceChildren();

		function openCalculator() {
			history.replaceState(null, '', window.location.pathname + window.location.search);
			render();
		}

		const main = document.getElementById('app');
		if (!view) {
			main.replaceChildren(el('section', { class: 'card empty' }, [
				el('p', { text: t('shareBad') }),
				el('button', { type: 'button', class: 'btn', onclick: openCalculator }, t('openCalculator')),
			]));
			return;
		}
		main.replaceChildren(el('div', { class: 'stack' }, [
			renderReportBody(view),
			el('div', { class: 'row no-print' }, [
				el('button', { type: 'button', class: 'btn', onclick: function () { window.print(); } }, t('print')),
			]),
		]));
	}

	/* ------------------------------------------------------------------ */
	/* Staff tab                                                           */
	/* ------------------------------------------------------------------ */

	function nameTaken(name, exceptId) {
		const n = name.toLowerCase();
		return data.servers.some(function (s) { return s.id !== exceptId && s.name.toLowerCase() === n; });
	}

	function serverHasHistory(id) {
		return data.shifts.some(function (s) { return s.hours[id]; });
	}

	function renderStaffTab() {
		const nameInput = el('input', { type: 'text', maxlength: C.MAX_NAME_LENGTH, placeholder: t('serverNamePlaceholder'), autocomplete: 'off' });

		function onAdd(ev) {
			ev.preventDefault();
			const name = C.cleanName(nameInput.value);
			if (!name) {
				toast(t('errEmptyName'), 'error');
				return;
			}
			if (nameTaken(name)) {
				toast(t('errDuplicateName'), 'error');
				return;
			}
			data.servers.push({ id: genId('sv_'), name: name, active: true });
			if (save()) {
				render();
				const again = document.querySelector('.add-server input');
				if (again) {
					again.focus();
				}
			}
		}

		function move(i, d) {
			const j = i + d;
			if (j < 0 || j >= data.servers.length) {
				return;
			}
			const tmp = data.servers[i];
			data.servers[i] = data.servers[j];
			data.servers[j] = tmp;
			if (save()) {
				render();
			}
		}

		const list = data.servers.map(function (s, i) {
			const used = serverHasHistory(s.id);
			return el('li', { class: 'server-row' + (s.active ? '' : ' is-inactive') }, [
				el('input', {
					type: 'text',
					maxlength: C.MAX_NAME_LENGTH,
					value: s.name,
					'aria-label': t('serverNamePlaceholder'),
					onchange: function (e) {
						const name = C.cleanName(e.target.value);
						if (!name || nameTaken(name, s.id)) {
							toast(t(name ? 'errDuplicateName' : 'errEmptyName'), 'error');
							e.target.value = s.name;
							return;
						}
						s.name = name;
						if (save()) {
							render();
						}
					},
				}),
				el('span', { class: 'badge ' + (s.active ? 'on' : 'off'), text: s.active ? t('active') : t('inactive') }),
				el('div', { class: 'row tight' }, [
					el('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('moveUp'), disabled: i === 0, onclick: function () { move(i, -1); } }, '↑'),
					el('button', { type: 'button', class: 'btn small ghost', 'aria-label': t('moveDown'), disabled: i === data.servers.length - 1, onclick: function () { move(i, 1); } }, '↓'),
					el('button', {
						type: 'button',
						class: 'btn small',
						onclick: function () {
							s.active = !s.active;
							if (save()) {
								render();
							}
						},
					}, s.active ? t('deactivate') : t('activate')),
					el('button', {
						type: 'button',
						class: 'btn small ghost danger',
						disabled: used,
						title: used ? t('cannotDeleteUsed') : null,
						onclick: function () {
							if (!window.confirm(t('confirmDeleteServer', { name: s.name }))) {
								return;
							}
							data.servers = data.servers.filter(function (x) { return x.id !== s.id; });
							if (save()) {
								render();
							}
						},
					}, t('delete')),
				]),
			]);
		});

		return el('section', { class: 'card' }, [
			el('h2', { text: t('staffTitle') }),
			el('p', { class: 'muted', text: t('staffHelp') }),
			el('form', { class: 'row add-server', onsubmit: onAdd }, [
				nameInput,
				el('button', { type: 'submit', class: 'btn primary' }, t('addServer')),
			]),
			el('ul', { class: 'server-list' }, list),
		]);
	}

	/* ------------------------------------------------------------------ */
	/* Settings tab                                                        */
	/* ------------------------------------------------------------------ */

	function renderSettingsTab() {
		const st = data.settings;
		const cur = C.periodFor(st.periodAnchor, C.todayIso());

		function set(key, value) {
			st[key] = value;
			if (save()) {
				render();
			}
		}

		function onImport(e) {
			const file = e.target.files && e.target.files[0];
			e.target.value = '';
			if (!file) {
				return;
			}
			file.text().then(function (text) {
				let next;
				try {
					next = C.normalizeData(JSON.parse(text));
				} catch (err) {
					toast(t('importFailed'), 'error');
					return;
				}
				if (!window.confirm(t('confirmImport', { servers: next.servers.length, shifts: next.shifts.length }))) {
					return;
				}
				data = next;
				loadRecovered = false;
				if (save()) {
					toast(t('importDone'));
					render();
				}
			});
		}

		const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', onchange: onImport });

		return el('div', { class: 'stack' }, [
			el('section', { class: 'card form' }, [
				el('h2', { text: t('settingsTitle') }),
				el('label', { class: 'field' }, [
					el('span', { text: t('restaurantName') }),
					el('input', {
						type: 'text',
						maxlength: C.MAX_NAME_LENGTH,
						value: st.restaurantName,
						onchange: function (e) { set('restaurantName', C.cleanName(e.target.value)); },
					}),
				]),
				el('div', { class: 'row wrap' }, [
					el('label', { class: 'field' }, [
						el('span', { text: t('language') }),
						el('select', { onchange: function (e) { set('lang', e.target.value); } }, [
							el('option', { value: '', selected: !st.lang }, t('langAuto')),
							el('option', { value: 'ko', selected: 'ko' === st.lang }, '한국어'),
							el('option', { value: 'en', selected: 'en' === st.lang }, 'English'),
						]),
					]),
					el('label', { class: 'field' }, [
						el('span', { text: t('currency') }),
						el('select', { onchange: function (e) { set('currency', e.target.value); } }, C.CURRENCIES.map(function (c) {
							return el('option', { value: c, selected: c === st.currency }, c);
						})),
					]),
				]),
				el('label', { class: 'field' }, [
					el('span', { text: t('periodAnchor') }),
					el('input', {
						type: 'date',
						value: st.periodAnchor,
						onchange: function (e) {
							if (C.isIsoDate(e.target.value)) {
								set('periodAnchor', e.target.value);
							}
						},
					}),
					el('small', { class: 'muted', text: t('periodAnchorHelp', { from: niceDate(cur.from, true), to: niceDate(cur.to, true) }) }),
				]),
				el('fieldset', { class: 'field' }, [
					el('legend', { text: t('splitMode') }),
					radio('perShift', t('splitPerShift'), t('splitPerShiftHelp')),
					radio('pooled', t('splitPooled'), t('splitPooledHelp')),
				]),
			]),
			el('section', { class: 'card' }, [
				el('h2', { text: t('backupTitle') }),
				el('p', { class: 'muted', text: t('backupHelp') }),
				el('div', { class: 'row wrap' }, [
					el('button', {
						type: 'button',
						class: 'btn primary',
						onclick: function () {
							download('kai-calculator-backup-' + C.todayIso() + '.json', JSON.stringify(data, null, 2), 'application/json');
						},
					}, t('exportJson')),
					el('button', { type: 'button', class: 'btn', onclick: function () { fileInput.click(); } }, t('importJson')),
					fileInput,
				]),
			]),
			el('section', { class: 'card' }, [
				el('h2', { text: t('dangerTitle') }),
				el('button', {
					type: 'button',
					class: 'btn danger',
					onclick: function () {
						if (!window.confirm(t('confirmReset'))) {
							return;
						}
						data = C.emptyData();
						if (save()) {
							render();
						}
					},
				}, t('resetAll')),
			]),
		]);

		function radio(value, label, help) {
			return el('label', { class: 'radio' }, [
				el('input', { type: 'radio', name: 'splitMode', value: value, checked: st.splitMode === value, onchange: function () { set('splitMode', value); } }),
				el('span', null, [el('strong', { text: label }), el('small', { class: 'muted', text: help })]),
			]);
		}
	}

	/* ------------------------------------------------------------------ */
	/* Boot                                                                */
	/* ------------------------------------------------------------------ */

	data = load();

	window.addEventListener('hashchange', render);
	window.addEventListener('storage', function (e) {
		if (e.key !== STORAGE_KEY) {
			return;
		}
		data = load();
		render();
		toast(t('otherTabChanged'));
	});

	render();
}());
