/*
 * Kai Calculator — pure calculation logic (no DOM access).
 *
 * Loaded as a classic <script> in the browser (exposes window.KaiCalc) and
 * via require() in Node for the unit tests. No build step.
 *
 * Money is always stored as integer CENTS and hours as integer HUNDREDTHS
 * of an hour (5.5h = 550) so that no floating point rounding errors ever
 * creep into the totals.
 */
(function (root, factory) {
	'use strict';
	const api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	} else {
		root.KaiCalc = api;
	}
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	const SHIFT_TYPES = ['day', 'night'];
	const SPLIT_MODES = ['perShift', 'pooled'];
	const CURRENCIES = ['USD', 'CAD', 'AUD', 'NZD', 'EUR', 'GBP'];
	const LANGS = ['ko', 'en'];
	const PERIOD_DAYS = 14;
	const DATA_VERSION = 1;
	const MAX_CENTS = 100000000; // 1,000,000.00 per shift — sanity cap
	const MAX_SHIFT_HOURS = 2400; // 24h in hundredths
	const MAX_NAME_LENGTH = 60;
	const DEFAULT_ANCHOR = '2026-01-05'; // a Monday; change in Settings

	/* ------------------------------------------------------------------ */
	/* Dates — 'YYYY-MM-DD' strings, all arithmetic in UTC (no DST bugs)   */
	/* ------------------------------------------------------------------ */

	const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
	const DAY_MS = 86400000;

	function pad2(n) {
		return (n < 10 ? '0' : '') + n;
	}

	function isIsoDate(s) {
		const m = ISO_RE.exec(typeof s === 'string' ? s : '');
		if (!m) {
			return false;
		}
		const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
		return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
	}

	function toUtcMs(iso) {
		const m = ISO_RE.exec(iso);
		return Date.UTC(+m[1], +m[2] - 1, +m[3]);
	}

	function fromUtcMs(ms) {
		const d = new Date(ms);
		return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
	}

	function addDays(iso, n) {
		return fromUtcMs(toUtcMs(iso) + n * DAY_MS);
	}

	function diffDays(a, b) {
		return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
	}

	/** Today's date in the device's local time zone. */
	function todayIso(now) {
		const d = now || new Date();
		return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
	}

	/** The 14-day pay period (anchored on `anchor`) that contains `iso`. */
	function periodFor(anchor, iso) {
		const k = Math.floor(diffDays(anchor, iso) / PERIOD_DAYS);
		const from = addDays(anchor, k * PERIOD_DAYS);
		return { from: from, to: addDays(from, PERIOD_DAYS - 1) };
	}

	function monthKey(iso) {
		return iso.slice(0, 7);
	}

	function monthRange(ym) {
		const y = +ym.slice(0, 4);
		const m = +ym.slice(5, 7);
		// Day 0 of the next month = last day of this month.
		return { from: ym + '-01', to: fromUtcMs(Date.UTC(y, m, 0)) };
	}

	function shiftMonth(ym, n) {
		const y = +ym.slice(0, 4);
		const m = +ym.slice(5, 7);
		return fromUtcMs(Date.UTC(y, m - 1 + n, 1)).slice(0, 7);
	}

	/**
	 * Pay periods overlapping [from, to], clipped to that range.
	 * `partial` is true when the period was cut by the range edges.
	 */
	function periodsInRange(anchor, from, to) {
		const out = [];
		let p = periodFor(anchor, from);
		while (p.from <= to) {
			const cf = p.from < from ? from : p.from;
			const ct = p.to > to ? to : p.to;
			out.push({ from: cf, to: ct, fullFrom: p.from, fullTo: p.to, partial: cf !== p.from || ct !== p.to });
			p = periodFor(anchor, addDays(p.to, 1));
		}
		return out;
	}

	/* ------------------------------------------------------------------ */
	/* Parsing / formatting user input                                     */
	/* ------------------------------------------------------------------ */

	/**
	 * "1,234.56" / "$80" / "80.5" → cents (integer). Commas are treated as
	 * thousands separators. Returns null for empty or invalid input.
	 */
	function parseMoney(input) {
		const s = String(input == null ? '' : input).trim().replace(/[\s$€£,]/g, '');
		const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s) || /^()\.(\d{1,2})$/.exec(s);
		if (!m) {
			return null;
		}
		const cents = (m[1] ? parseInt(m[1], 10) : 0) * 100 + parseInt((m[2] || '').padEnd(2, '0') || '0', 10);
		return cents <= MAX_CENTS ? cents : null;
	}

	/**
	 * "5" / "5.5" / "5.25" / "5:30" → hundredths of an hour (integer).
	 * Returns null for empty or invalid input, or more than 24h.
	 */
	function parseHours(input) {
		const s = String(input == null ? '' : input).trim().replace(',', '.');
		let v = null;
		let m = /^(\d{1,2})(?:\.(\d{0,2}))?$/.exec(s) || /^()\.(\d{1,2})$/.exec(s);
		if (m) {
			v = (m[1] ? parseInt(m[1], 10) : 0) * 100 + parseInt((m[2] || '').padEnd(2, '0') || '0', 10);
		} else {
			m = /^(\d{1,2}):([0-5]\d)$/.exec(s);
			if (m) {
				v = parseInt(m[1], 10) * 100 + Math.round(parseInt(m[2], 10) * 100 / 60);
			}
		}
		return v !== null && v <= MAX_SHIFT_HOURS ? v : null;
	}

	/** 550 → "5.5", 500 → "5", 525 → "5.25" */
	function formatHours(h) {
		return (h / 100).toFixed(2).replace(/\.?0+$/, '');
	}

	/** 1250 → "12.50" (plain, for inputs and CSV) */
	function centsToPlain(c) {
		return (c / 100).toFixed(2);
	}

	/* ------------------------------------------------------------------ */
	/* Splitting                                                           */
	/* ------------------------------------------------------------------ */

	/**
	 * Split `total` cents proportionally to integer weights using the
	 * largest-remainder method, so the parts ALWAYS add up to exactly
	 * `total` (no lost or invented cents).
	 * Ties are broken by input order, so the result is deterministic.
	 *
	 * @param {number} total integer cents
	 * @param {{key:string, weight:number}[]} entries weights > 0
	 * @returns {Object<string, number>} key → cents
	 */
	function splitByWeight(total, entries) {
		const out = {};
		const sumW = entries.reduce(function (a, e) { return a + e.weight; }, 0);
		if (!entries.length || sumW <= 0) {
			return out;
		}
		let given = 0;
		const rems = entries.map(function (e, i) {
			const exact = total * e.weight; // safe: < 2^53 for realistic inputs
			const base = Math.floor(exact / sumW);
			out[e.key] = (out[e.key] || 0) + base;
			given += base;
			return { key: e.key, rem: exact % sumW, i: i };
		});
		rems.sort(function (a, b) { return b.rem - a.rem || a.i - b.i; });
		for (let j = 0; j < total - given; j++) {
			out[rems[j].key] += 1;
		}
		return out;
	}

	/* ------------------------------------------------------------------ */
	/* Data model                                                          */
	/* ------------------------------------------------------------------ */

	function defaultSettings() {
		return {
			restaurantName: '',
			currency: 'USD',
			periodAnchor: DEFAULT_ANCHOR,
			splitMode: 'perShift',
			lang: '', // '' = follow the browser
		};
	}

	function emptyData() {
		return { version: DATA_VERSION, settings: defaultSettings(), servers: [], shifts: [] };
	}

	function cleanName(s) {
		return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
	}

	function isInt(n, min, max) {
		return Number.isInteger(n) && n >= min && n <= max;
	}

	/**
	 * Validate and repair data loaded from storage or an imported backup.
	 * Invalid pieces are dropped instead of crashing the app.
	 * Throws only when the input is not Kai Calculator data at all.
	 */
	function normalizeData(raw) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			throw new Error('not-kai-data');
		}
		if (typeof raw.version === 'number' && raw.version > DATA_VERSION) {
			throw new Error('newer-version');
		}
		if (!Array.isArray(raw.servers) || !Array.isArray(raw.shifts)) {
			throw new Error('not-kai-data');
		}
		const data = emptyData();
		const rs = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
		data.settings.restaurantName = cleanName(rs.restaurantName);
		data.settings.currency = CURRENCIES.indexOf(rs.currency) >= 0 ? rs.currency : 'USD';
		data.settings.periodAnchor = isIsoDate(rs.periodAnchor) ? rs.periodAnchor : DEFAULT_ANCHOR;
		data.settings.splitMode = SPLIT_MODES.indexOf(rs.splitMode) >= 0 ? rs.splitMode : 'perShift';
		data.settings.lang = LANGS.indexOf(rs.lang) >= 0 ? rs.lang : '';

		const seenIds = {};
		raw.servers.forEach(function (s) {
			if (!s || typeof s.id !== 'string' || !s.id || seenIds[s.id]) {
				return;
			}
			const name = cleanName(s.name);
			if (!name) {
				return;
			}
			seenIds[s.id] = true;
			data.servers.push({ id: s.id, name: name, active: s.active !== false });
		});

		const byKey = {};
		raw.shifts.forEach(function (sh) {
			if (!sh || !isIsoDate(sh.date) || SHIFT_TYPES.indexOf(sh.type) < 0 || !isInt(sh.tipsCents, 0, MAX_CENTS)) {
				return;
			}
			const hours = {};
			if (sh.hours && typeof sh.hours === 'object') {
				Object.keys(sh.hours).forEach(function (id) {
					const h = sh.hours[id];
					if (seenIds[id] && isInt(h, 1, MAX_SHIFT_HOURS)) {
						hours[id] = h;
					}
				});
			}
			byKey[sh.date + '|' + sh.type] = {
				id: typeof sh.id === 'string' && sh.id ? sh.id : 'sh_' + sh.date + '_' + sh.type,
				date: sh.date,
				type: sh.type,
				tipsCents: sh.tipsCents,
				hours: hours,
			};
		});
		data.shifts = Object.keys(byKey).sort().map(function (k) { return byKey[k]; });
		return data;
	}

	/* ------------------------------------------------------------------ */
	/* Summaries                                                           */
	/* ------------------------------------------------------------------ */

	/** Add totals / per-hour to rows: {name, dayHours, nightHours, dayTips, nightTips}. */
	function finishRows(rows) {
		const totals = { dayHours: 0, nightHours: 0, hours: 0, dayTips: 0, nightTips: 0, tips: 0 };
		const out = rows.map(function (r) {
			const hours = r.dayHours + r.nightHours;
			const tips = r.dayTips + r.nightTips;
			totals.dayHours += r.dayHours;
			totals.nightHours += r.nightHours;
			totals.dayTips += r.dayTips;
			totals.nightTips += r.nightTips;
			return {
				id: r.id,
				name: r.name,
				dayHours: r.dayHours,
				nightHours: r.nightHours,
				hours: hours,
				dayTips: r.dayTips,
				nightTips: r.nightTips,
				tips: tips,
				perHourCents: hours > 0 ? Math.round(tips * 100 / hours) : 0,
			};
		});
		totals.hours = totals.dayHours + totals.nightHours;
		totals.tips = totals.dayTips + totals.nightTips;
		totals.perHourCents = totals.hours > 0 ? Math.round(totals.tips * 100 / totals.hours) : 0;
		return { rows: out, totals: totals };
	}

	/**
	 * Per-server totals for all shifts in [from, to] (inclusive).
	 *
	 * splitMode 'perShift': each shift's tips are split between the people
	 *   who worked THAT shift, by hours. (Default — the fairest.)
	 * splitMode 'pooled': all day tips in the range are pooled and split by
	 *   total day hours; same for night.
	 *
	 * Tips that cannot be given to anyone (tips entered but nobody has
	 * hours) are reported in `unallocated` and never silently dropped.
	 */
	function summarize(data, from, to) {
		const mode = data.settings.splitMode;
		const serverIndex = {};
		data.servers.forEach(function (s, i) { serverIndex[s.id] = i; });
		const stats = {};

		function row(id) {
			if (!stats[id]) {
				const i = serverIndex[id];
				stats[id] = {
					id: id,
					name: i === undefined ? null : data.servers[i].name,
					dayHours: 0,
					nightHours: 0,
					dayTips: 0,
					nightTips: 0,
				};
			}
			return stats[id];
		}

		const shifts = data.shifts.filter(function (sh) { return sh.date >= from && sh.date <= to; });
		const pools = { day: 0, night: 0 };
		const unallocated = [];

		shifts.forEach(function (sh) {
			pools[sh.type] += sh.tipsCents;
			const entries = [];
			Object.keys(sh.hours).forEach(function (id) {
				if (sh.hours[id] > 0) {
					row(id)[sh.type + 'Hours'] += sh.hours[id];
					entries.push({ key: id, weight: sh.hours[id] });
				}
			});
			if (mode !== 'perShift') {
				return;
			}
			if (!entries.length) {
				if (sh.tipsCents > 0) {
					unallocated.push({ date: sh.date, type: sh.type, cents: sh.tipsCents });
				}
				return;
			}
			const split = splitByWeight(sh.tipsCents, sortEntries(entries, serverIndex));
			Object.keys(split).forEach(function (id) { row(id)[sh.type + 'Tips'] += split[id]; });
		});

		if (mode === 'pooled') {
			SHIFT_TYPES.forEach(function (type) {
				const entries = Object.keys(stats)
					.filter(function (id) { return stats[id][type + 'Hours'] > 0; })
					.map(function (id) { return { key: id, weight: stats[id][type + 'Hours'] }; });
				if (!entries.length) {
					if (pools[type] > 0) {
						unallocated.push({ date: null, type: type, cents: pools[type] });
					}
					return;
				}
				const split = splitByWeight(pools[type], sortEntries(entries, serverIndex));
				Object.keys(split).forEach(function (id) { stats[id][type + 'Tips'] += split[id]; });
			});
		}

		const ordered = Object.keys(stats).map(function (id) { return stats[id]; });
		sortEntries(ordered, serverIndex, 'id');
		const done = finishRows(ordered);
		return {
			from: from,
			to: to,
			mode: mode,
			shiftCount: shifts.length,
			rows: done.rows,
			totals: done.totals,
			unallocated: unallocated,
			unallocatedCents: unallocated.reduce(function (a, u) { return a + u.cents; }, 0),
		};
	}

	/** Sort in-place by the server list order (unknown ids last, then by id). */
	function sortEntries(list, serverIndex, field) {
		const f = field || 'key';
		return list.sort(function (a, b) {
			const ia = serverIndex[a[f]] === undefined ? Infinity : serverIndex[a[f]];
			const ib = serverIndex[b[f]] === undefined ? Infinity : serverIndex[b[f]];
			if (ia !== ib) {
				return ia < ib ? -1 : 1;
			}
			return a[f] < b[f] ? -1 : (a[f] > b[f] ? 1 : 0);
		});
	}

	/* ------------------------------------------------------------------ */
	/* Share links — the report is encoded into the URL (#r=...)           */
	/* ------------------------------------------------------------------ */

	function compactRows(rows) {
		return rows.map(function (r) {
			return [r.name || '', r.dayHours, r.nightHours, r.dayTips, r.nightTips];
		});
	}

	function expandRows(rows) {
		if (!Array.isArray(rows) || rows.length > 500) {
			throw new Error('bad-share');
		}
		return finishRows(rows.map(function (r) {
			if (!Array.isArray(r) || r.length !== 5 || typeof r[0] !== 'string' ||
				!r.slice(1).every(function (n) { return isInt(n, 0, MAX_CENTS * 1000); })) {
				throw new Error('bad-share');
			}
			return { id: null, name: cleanName(r[0]) || null, dayHours: r[1], nightHours: r[2], dayTips: r[3], nightTips: r[4] };
		}));
	}

	/**
	 * view: { title, currency, lang, kind: 'period'|'month', mode, from, to,
	 *         generatedAt, rows, unallocatedCents, sections: [{from,to,partial,rows,unallocatedCents}] }
	 */
	function buildSharePayload(view) {
		return {
			v: 1,
			t: view.title || '',
			c: view.currency,
			l: view.lang,
			k: view.kind,
			m: view.mode,
			f: view.from,
			to: view.to,
			g: view.generatedAt,
			u: view.unallocatedCents || 0,
			r: compactRows(view.rows),
			s: (view.sections || []).map(function (s) {
				return { f: s.from, to: s.to, p: s.partial ? 1 : 0, u: s.unallocatedCents || 0, r: compactRows(s.rows) };
			}),
		};
	}

	/** Decode + validate a share payload back into a view. Throws on bad input. */
	function viewFromSharePayload(p) {
		if (!p || p.v !== 1 || !isIsoDate(p.f) || !isIsoDate(p.to) || !Array.isArray(p.s) || p.s.length > 10) {
			throw new Error('bad-share');
		}
		const main = expandRows(p.r);
		return {
			title: cleanName(p.t),
			currency: CURRENCIES.indexOf(p.c) >= 0 ? p.c : 'USD',
			lang: LANGS.indexOf(p.l) >= 0 ? p.l : 'en',
			kind: p.k === 'month' ? 'month' : 'period',
			mode: SPLIT_MODES.indexOf(p.m) >= 0 ? p.m : 'perShift',
			from: p.f,
			to: p.to,
			generatedAt: typeof p.g === 'string' ? p.g.slice(0, 40) : '',
			rows: main.rows,
			totals: main.totals,
			unallocatedCents: isInt(p.u, 0, MAX_CENTS * 1000) ? p.u : 0,
			sections: p.s.map(function (s) {
				if (!s || !isIsoDate(s.f) || !isIsoDate(s.to)) {
					throw new Error('bad-share');
				}
				const x = expandRows(s.r);
				return {
					from: s.f,
					to: s.to,
					partial: s.p === 1,
					rows: x.rows,
					totals: x.totals,
					unallocatedCents: isInt(s.u, 0, MAX_CENTS * 1000) ? s.u : 0,
				};
			}),
		};
	}

	function encodeShare(payload) {
		const bytes = new TextEncoder().encode(JSON.stringify(payload));
		let bin = '';
		for (let i = 0; i < bytes.length; i++) {
			bin += String.fromCharCode(bytes[i]);
		}
		return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	function decodeShare(str) {
		let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
		while (s.length % 4) {
			s += '=';
		}
		const bin = atob(s);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) {
			bytes[i] = bin.charCodeAt(i);
		}
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	}

	return {
		SHIFT_TYPES: SHIFT_TYPES,
		SPLIT_MODES: SPLIT_MODES,
		CURRENCIES: CURRENCIES,
		LANGS: LANGS,
		PERIOD_DAYS: PERIOD_DAYS,
		MAX_NAME_LENGTH: MAX_NAME_LENGTH,
		isIsoDate: isIsoDate,
		toUtcMs: toUtcMs,
		addDays: addDays,
		diffDays: diffDays,
		todayIso: todayIso,
		periodFor: periodFor,
		monthKey: monthKey,
		monthRange: monthRange,
		shiftMonth: shiftMonth,
		periodsInRange: periodsInRange,
		parseMoney: parseMoney,
		parseHours: parseHours,
		formatHours: formatHours,
		centsToPlain: centsToPlain,
		splitByWeight: splitByWeight,
		defaultSettings: defaultSettings,
		emptyData: emptyData,
		cleanName: cleanName,
		normalizeData: normalizeData,
		finishRows: finishRows,
		summarize: summarize,
		buildSharePayload: buildSharePayload,
		viewFromSharePayload: viewFromSharePayload,
		encodeShare: encodeShare,
		decodeShare: decodeShare,
	};
}));
