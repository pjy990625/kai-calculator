/*
 * Kai Calculator — pure calculation logic (no DOM, no network).
 *
 * Loaded as a classic <script> in the browser (window.KaiCalc) and via
 * require() in Node for the unit tests. No build step.
 *
 * Money is always integer CENTS and hours are integer HUNDREDTHS of an
 * hour (5.5h = 550), so no floating point rounding errors creep in.
 *
 * Tip rule (per date):
 *   night tips  = whole-day total − day tips
 *   per shift:  servers' pool = tips × server% (default 60%)
 *               kitchen/sushi = tips − servers' pool (40%)
 *               server A      = servers' pool ÷ all servers' hours on that shift × A's hours
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

	const SHIFTS = ['day', 'night'];
	const PERIOD_DAYS = 14;
	const MAX_CENTS = 100000000;
	const MAX_SHIFT_HOURS = 2400;
	const MAX_NAME_LENGTH = 60;

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

	/* ------------------------------------------------------------------ */
	/* Parsing / formatting user input                                     */
	/* ------------------------------------------------------------------ */

	/**
	 * "1,234.56" / "$80" / "80.5" → cents. Commas are thousands separators.
	 * Returns null for empty or invalid input.
	 */
	function parseMoney(input) {
		const s = String(input == null ? '' : input).trim().replace(/[\s$,]/g, '');
		const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s) || /^()\.(\d{1,2})$/.exec(s);
		if (!m) {
			return null;
		}
		const cents = (m[1] ? parseInt(m[1], 10) : 0) * 100 + parseInt((m[2] || '').padEnd(2, '0'), 10);
		return cents <= MAX_CENTS ? cents : null;
	}

	/**
	 * "5" / "5.5" / "5.25" / "5:30" → hundredths of an hour.
	 * Returns null for empty or invalid input, or more than 24h.
	 */
	function parseHours(input) {
		const s = String(input == null ? '' : input).trim().replace(',', '.');
		let v = null;
		let m = /^(\d{1,2})(?:\.(\d{0,2}))?$/.exec(s) || /^()\.(\d{1,2})$/.exec(s);
		if (m) {
			v = (m[1] ? parseInt(m[1], 10) : 0) * 100 + parseInt((m[2] || '').padEnd(2, '0'), 10);
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

	function cleanName(s) {
		return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
	}

	/* ------------------------------------------------------------------ */
	/* Splitting                                                           */
	/* ------------------------------------------------------------------ */

	/**
	 * Split `total` cents proportionally to integer weights using the
	 * largest-remainder method, so the parts ALWAYS add up to exactly
	 * `total`. Ties go to the earlier entry, so results are deterministic.
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
			const exact = total * e.weight; // < 2^53 for realistic inputs
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

	/** Servers' part of `tips` at `pct` percent, rounded half-up to the cent. */
	function serverPool(tips, pct) {
		return Math.floor((tips * pct + 50) / 100);
	}

	/**
	 * One shift: servers get `pct`% split by hours, the rest goes to the kitchen.
	 * If nobody has hours, the servers' pool is reported as `unallocated`.
	 */
	function splitShift(tips, pct, entries) {
		const pool = serverPool(tips, pct);
		const worked = entries.filter(function (e) { return e.weight > 0; });
		return {
			tips: tips,
			pool: pool,
			kitchen: tips - pool,
			shares: worked.length ? splitByWeight(pool, worked) : {},
			unallocated: worked.length ? 0 : pool,
		};
	}

	/** Night tips of a day record (0 while the whole-day total is unknown). */
	function nightTips(day) {
		return day.totalTips === null || day.totalTips === undefined ? 0 : day.totalTips - day.dayTips;
	}

	/* ------------------------------------------------------------------ */
	/* Summaries                                                           */
	/* ------------------------------------------------------------------ */

	function emptyTotals() {
		return { dayHours: 0, nightHours: 0, hours: 0, dayTips: 0, nightTips: 0, tips: 0, perHourCents: 0 };
	}

	function finishRow(r) {
		r.hours = r.dayHours + r.nightHours;
		r.tips = r.dayTips + r.nightTips;
		r.perHourCents = r.hours > 0 ? Math.round(r.tips * 100 / r.hours) : 0;
		return r;
	}

	/**
	 * Per-server totals and per-day details for [from, to] (inclusive).
	 *
	 * @param {{serverPct:number, servers:{id,name}[], days:{date,dayTips,totalTips}[],
	 *          hours:{date,serverId,shift,hundredths}[]}} input
	 */
	function summarize(input, from, to) {
		const pct = input.serverPct;
		const order = {};
		input.servers.forEach(function (s, i) { order[s.id] = i; });
		function byServerOrder(a, b) {
			const ia = order[a] === undefined ? Infinity : order[a];
			const ib = order[b] === undefined ? Infinity : order[b];
			if (ia !== ib) {
				return ia < ib ? -1 : 1;
			}
			return a < b ? -1 : (a > b ? 1 : 0);
		}

		const hoursByDate = {};
		input.hours.forEach(function (h) {
			if (h.date >= from && h.date <= to && h.hundredths > 0) {
				(hoursByDate[h.date] = hoursByDate[h.date] || []).push(h);
			}
		});

		const rows = {};
		function row(id) {
			if (!rows[id]) {
				const i = order[id];
				rows[id] = Object.assign(emptyTotals(), { id: id, name: i === undefined ? null : input.servers[i].name });
			}
			return rows[id];
		}

		const totals = Object.assign(emptyTotals(), { pool: 0, kitchen: 0, unallocated: 0, serverTips: 0 });
		const dayList = [];
		const warnings = [];

		input.days
			.filter(function (d) { return d.date >= from && d.date <= to; })
			.sort(function (a, b) { return a.date < b.date ? -1 : 1; })
			.forEach(function (d) {
				const tipsByShift = { day: d.dayTips, night: nightTips(d) };
				const detail = {
					date: d.date,
					dayTips: d.dayTips,
					nightTips: tipsByShift.night,
					totalTips: d.totalTips,
					pool: 0,
					kitchen: 0,
					dayHours: 0,
					nightHours: 0,
				};
				if (d.totalTips === null || d.totalTips === undefined) {
					warnings.push({ type: 'missingTotal', date: d.date });
				}
				SHIFTS.forEach(function (shift) {
					const entries = (hoursByDate[d.date] || [])
						.filter(function (h) { return h.shift === shift; })
						.sort(function (a, b) { return byServerOrder(a.serverId, b.serverId); })
						.map(function (h) { return { key: h.serverId, weight: h.hundredths }; });
					const r = splitShift(tipsByShift[shift], pct, entries);
					entries.forEach(function (e) {
						row(e.key)[shift + 'Hours'] += e.weight;
						detail[shift + 'Hours'] += e.weight;
					});
					Object.keys(r.shares).forEach(function (id) { row(id)[shift + 'Tips'] += r.shares[id]; });
					detail.pool += r.pool;
					detail.kitchen += r.kitchen;
					totals[shift + 'Tips'] += r.tips;
					totals.pool += r.pool;
					totals.kitchen += r.kitchen;
					totals.unallocated += r.unallocated;
					if (r.unallocated > 0) {
						warnings.push({ type: 'noHours', date: d.date, shift: shift, cents: r.unallocated });
					}
				});
				dayList.push(detail);
			});

		const list = Object.keys(rows).sort(byServerOrder).map(function (id) { return finishRow(rows[id]); });
		list.forEach(function (r) {
			totals.dayHours += r.dayHours;
			totals.nightHours += r.nightHours;
			totals.serverTips += r.tips;
		});
		totals.hours = totals.dayHours + totals.nightHours;
		totals.tips = totals.dayTips + totals.nightTips;
		totals.perHourCents = totals.hours > 0 ? Math.round(totals.serverTips * 100 / totals.hours) : 0;

		return { from: from, to: to, serverPct: pct, rows: list, days: dayList, totals: totals, warnings: warnings };
	}

	return {
		SHIFTS: SHIFTS,
		PERIOD_DAYS: PERIOD_DAYS,
		MAX_NAME_LENGTH: MAX_NAME_LENGTH,
		isIsoDate: isIsoDate,
		toUtcMs: toUtcMs,
		addDays: addDays,
		diffDays: diffDays,
		periodFor: periodFor,
		monthKey: monthKey,
		monthRange: monthRange,
		shiftMonth: shiftMonth,
		parseMoney: parseMoney,
		parseHours: parseHours,
		formatHours: formatHours,
		centsToPlain: centsToPlain,
		cleanName: cleanName,
		splitByWeight: splitByWeight,
		serverPool: serverPool,
		splitShift: splitShift,
		nightTips: nightTips,
		summarize: summarize,
	};
}));
