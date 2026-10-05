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
 *
 * Rounding rule (the restaurant's): each server's share is paid in WHOLE
 * DOLLARS. Shares of .50 or more round up, largest fraction first, but only
 * while the servers' total stays at or below the servers' pool. Servers with
 * the same fraction (e.g. the same hours) are rounded up together or not at
 * all. Whatever is left of the pool is reported as `leftover`.
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

	/**
	 * The pay period containing `iso`. Pay periods are always the 1st–15th
	 * and the 16th–last day of each month.
	 */
	function payPeriodFor(iso) {
		const ym = iso.slice(0, 7);
		if (+iso.slice(8, 10) <= 15) {
			return { from: ym + '-01', to: ym + '-15' };
		}
		return { from: ym + '-16', to: monthRange(ym).to };
	}

	/** The pay period `n` periods before (n < 0) or after (n > 0) the one containing `iso`. */
	function shiftPayPeriod(iso, n) {
		let p = payPeriodFor(iso);
		for (let i = 0; i < Math.abs(n); i++) {
			p = payPeriodFor(n > 0 ? addDays(p.to, 1) : addDays(p.from, -1));
		}
		return p;
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
	 * "1,234.56" / "$80" / "80.5" → cents. Commas are thousands separators,
	 * except "12,5" / "12,50" (a comma followed by 1–2 digits and no dot),
	 * which some phone keyboards type as the decimal point.
	 * Returns null for empty or invalid input.
	 */
	function parseMoney(input) {
		let s = String(input == null ? '' : input).trim().replace(/[\s$]/g, '');
		s = /^\d*,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
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
	 * Split the servers' pool of one shift into WHOLE DOLLARS (returned in cents).
	 *
	 * Exact share of A = tips × pct% × A's hours ÷ all hours. Everyone first gets
	 * the whole dollars of their exact share. Then shares whose fraction is .50
	 * or more are rounded up, the largest fraction first, while the sum stays
	 * <= tips × pct% (the servers' pool). People with the same fraction are one
	 * group: if the group does not fit as a whole, nobody in it is rounded up,
	 * and nobody with a smaller fraction is rounded up either (no one jumps the
	 * queue). All arithmetic is in integers, so there are no float errors.
	 *
	 * @param {number} tips integer cents
	 * @param {number} pct servers' percent (0–100)
	 * @param {{key:string, weight:number}[]} entries weights (hundredths of hours) > 0
	 * @returns {Object<string, number>} key → cents (always a multiple of 100)
	 */
	function splitWholeDollars(tips, pct, entries) {
		const out = {};
		const sumW = entries.reduce(function (a, e) { return a + e.weight; }, 0);
		if (!entries.length || sumW <= 0) {
			return out;
		}
		// Exact share in dollars = tips·pct·w / (100 cents · 100 % · sumW).
		const den = 10000 * sumW;
		const maxDollars = Math.floor(tips * pct / 10000); // the sum may never exceed the pool
		let given = 0;
		const rems = {};
		entries.forEach(function (e) {
			const exact = tips * pct * e.weight; // < 2^53 for realistic inputs
			const dollars = Math.floor(exact / den);
			out[e.key] = dollars;
			given += dollars;
			const rem = exact % den;
			if (rem * 2 >= den) { // fraction >= .50 → wants to round up
				(rems[rem] = rems[rem] || []).push(e.key);
			}
		});
		let spare = maxDollars - given;
		const groups = Object.keys(rems).map(Number).sort(function (a, b) { return b - a; });
		for (let i = 0; i < groups.length; i++) {
			const keys = rems[groups[i]];
			if (keys.length > spare) {
				break;
			}
			keys.forEach(function (k) { out[k] += 1; });
			spare -= keys.length;
		}
		Object.keys(out).forEach(function (k) { out[k] *= 100; });
		return out;
	}

	/**
	 * One shift: servers get `pct`% split by hours (whole dollars, see
	 * splitWholeDollars), the rest goes to the kitchen.
	 *   pool = sum(shares) + leftover + unallocated, and pool + kitchen = tips.
	 * If nobody has hours, the servers' pool is reported as `unallocated`.
	 */
	function splitShift(tips, pct, entries) {
		const pool = serverPool(tips, pct);
		const worked = entries.filter(function (e) { return e.weight > 0; });
		const shares = worked.length ? splitWholeDollars(tips, pct, worked) : {};
		const paid = Object.keys(shares).reduce(function (a, k) { return a + shares[k]; }, 0);
		return {
			tips: tips,
			pool: pool,
			kitchen: tips - pool,
			shares: shares,
			leftover: worked.length ? pool - paid : 0,
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
		const serverDays = {}; // serverId → [{date, dayHours, nightHours, dayTips, nightTips, hours, tips}]
		function serverDay(id, date) {
			const list = serverDays[id] = serverDays[id] || [];
			let d = list.length ? list[list.length - 1] : null;
			if (!d || d.date !== date) {
				d = { date: date, dayHours: 0, nightHours: 0, dayTips: 0, nightTips: 0, hours: 0, tips: 0 };
				list.push(d);
			}
			return d;
		}
		function row(id) {
			if (!rows[id]) {
				const i = order[id];
				rows[id] = Object.assign(emptyTotals(), { id: id, name: i === undefined ? null : input.servers[i].name });
			}
			return rows[id];
		}

		const totals = Object.assign(emptyTotals(), { pool: 0, kitchen: 0, leftover: 0, unallocated: 0, serverTips: 0 });
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
					leftover: 0,
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
						const sd = serverDay(e.key, d.date);
						sd[shift + 'Hours'] += e.weight;
						sd.hours += e.weight;
					});
					Object.keys(r.shares).forEach(function (id) {
						row(id)[shift + 'Tips'] += r.shares[id];
						const sd = serverDay(id, d.date);
						sd[shift + 'Tips'] += r.shares[id];
						sd.tips += r.shares[id];
					});
					detail.pool += r.pool;
					detail.kitchen += r.kitchen;
					detail.leftover += r.leftover;
					totals[shift + 'Tips'] += r.tips;
					totals.pool += r.pool;
					totals.kitchen += r.kitchen;
					totals.leftover += r.leftover;
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

		return {
			from: from,
			to: to,
			serverPct: pct,
			rows: list,
			days: dayList,
			serverDays: serverDays,
			totals: totals,
			warnings: warnings,
		};
	}

	return {
		SHIFTS: SHIFTS,
		MAX_NAME_LENGTH: MAX_NAME_LENGTH,
		isIsoDate: isIsoDate,
		toUtcMs: toUtcMs,
		addDays: addDays,
		diffDays: diffDays,
		payPeriodFor: payPeriodFor,
		shiftPayPeriod: shiftPayPeriod,
		monthKey: monthKey,
		monthRange: monthRange,
		shiftMonth: shiftMonth,
		parseMoney: parseMoney,
		parseHours: parseHours,
		formatHours: formatHours,
		centsToPlain: centsToPlain,
		cleanName: cleanName,
		splitByWeight: splitByWeight,
		splitWholeDollars: splitWholeDollars,
		serverPool: serverPool,
		splitShift: splitShift,
		nightTips: nightTips,
		summarize: summarize,
	};
}));
