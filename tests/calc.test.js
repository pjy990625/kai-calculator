'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');

const servers = [
	{ id: 'a', name: 'Alice' },
	{ id: 'b', name: 'Bob' },
	{ id: 'c', name: 'Chris' },
];

function h(date, serverId, shift, hundredths) {
	return { date, serverId, shift, hundredths };
}

test('parseMoney', () => {
	assert.equal(C.parseMoney('80'), 8000);
	assert.equal(C.parseMoney('80.5'), 8050);
	assert.equal(C.parseMoney('$1,234.56'), 123456);
	assert.equal(C.parseMoney('.5'), 50);
	assert.equal(C.parseMoney(''), null);
	assert.equal(C.parseMoney('abc'), null);
	assert.equal(C.parseMoney('1.234'), null);
	assert.equal(C.parseMoney('-5'), null);
	// A trailing dot or comma is unfinished typing, not a whole number.
	assert.equal(C.parseMoney('400.'), null);
	assert.equal(C.parseMoney('400,'), null);
	assert.equal(C.parseMoney('.'), null);
	assert.equal(C.parseMoney('400.5'), 40050);
	// Phone keyboards that type a comma as the decimal point
	assert.equal(C.parseMoney('12,50'), 1250);
	assert.equal(C.parseMoney('12,5'), 1250);
	assert.equal(C.parseMoney('1,234'), 123400);
	assert.equal(C.parseMoney('12,345.67'), 1234567);
});

test('centsToInput drops .00 and reads back the same amount', () => {
	assert.equal(C.centsToInput(35000), '350');
	assert.equal(C.centsToInput(0), '0');
	assert.equal(C.centsToInput(1250), '12.50');
	assert.equal(C.centsToInput(5), '0.05');
	assert.equal(C.centsToInput(100000000), '1000000');
	for (const c of [0, 5, 99, 100, 1250, 35000, 99999999, 100000000]) {
		assert.equal(C.parseMoney(C.centsToInput(c)), c);
	}
	assert.equal(C.centsToPlain(35000), '350.00'); // CSV keeps two decimals
});

test('parseHours / formatHours', () => {
	assert.equal(C.parseHours('5'), 500);
	assert.equal(C.parseHours('5.5'), 550);
	assert.equal(C.parseHours('5:30'), 550);
	assert.equal(C.parseHours('5.25'), 525);
	assert.equal(C.parseHours('5.75'), 575);
	assert.equal(C.parseHours('.5'), 50);
	assert.equal(C.parseHours('5:45'), 575);
	// Only quarter hours: anything else is a typo.
	assert.equal(C.parseHours('5.3'), null);
	assert.equal(C.parseHours('5.33'), null);
	assert.equal(C.parseHours('5:20'), null);
	// A trailing dot or comma is unfinished typing, not a whole hour.
	assert.equal(C.parseHours('2.'), null);
	assert.equal(C.parseHours('2,'), null);
	assert.equal(C.parseHours('.'), null);
	assert.equal(C.parseHours('2,5'), 250); // decimal comma (some phone keyboards)
	assert.equal(C.parseHours('0.25'), 25);
	assert.equal(C.parseHours('2.50'), 250);
	assert.equal(C.parseHours('2.250'), null);
	assert.equal(C.parseHours('24'), 2400);
	assert.equal(C.parseHours('24.25'), null);
	assert.equal(C.parseHours('-2'), null);
	assert.equal(C.parseHours('5:'), null);
	assert.equal(C.parseHours('25'), null);
	assert.equal(C.parseHours('5:75'), null);
	assert.equal(C.formatHours(550), '5.5');
	assert.equal(C.formatHours(500), '5');
});

test('serverPool is 60% rounded half-up; kitchen gets exactly the rest', () => {
	assert.equal(C.serverPool(10000, 60), 6000);
	assert.equal(C.serverPool(10001, 60), 6001); // 6000.6 → 6001
	assert.equal(C.serverPool(10002, 60), 6001); // 6001.2 → 6001
	for (let t = 0; t < 5000; t++) {
		const s = C.splitShift(t, 60, [{ key: 'a', weight: 300 }, { key: 'b', weight: 700 }]);
		assert.equal(s.pool + s.kitchen, t);
		assert.equal(s.shares.a + s.shares.b + s.leftover, s.pool);
	}
});

test("the restaurant's formula: day and night (총팁 − 낮팁)", () => {
	// Day tips $500, whole-day total $1,500 → night tips $1,000.
	// Day:   500 × 0.6 = 300 → Alice 6h, Bob 4h        → 180 / 120
	// Night: 1000 × 0.6 = 600 → Alice 5h, Bob 5h, Chris 2h → 250 / 250 / 100
	const s = C.summarize({
		serverPct: 60,
		servers,
		days: [{ date: '2026-10-01', dayTips: 50000, totalTips: 150000 }],
		hours: [
			h('2026-10-01', 'a', 'day', 600), h('2026-10-01', 'b', 'day', 400),
			h('2026-10-01', 'a', 'night', 500), h('2026-10-01', 'b', 'night', 500), h('2026-10-01', 'c', 'night', 200),
		],
	}, '2026-09-28', '2026-10-11');
	const by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
	assert.equal(by.Alice.dayTips, 18000);
	assert.equal(by.Bob.dayTips, 12000);
	assert.equal(by.Alice.nightTips, 25000);
	assert.equal(by.Bob.nightTips, 25000);
	assert.equal(by.Chris.nightTips, 10000);
	assert.equal(by.Alice.tips, 43000);
	assert.equal(by.Alice.hours, 1100);
	assert.equal(s.totals.tips, 150000);
	assert.equal(s.totals.pool, 90000);
	assert.equal(s.totals.kitchen, 60000);
	assert.equal(s.totals.serverTips, 90000);
	assert.equal(s.days[0].nightTips, 100000);
	assert.deepEqual(s.rows.map((r) => r.name), ['Alice', 'Bob', 'Chris']);
	assert.deepEqual(s.warnings, []);
});

test('two-week totals add up across days and stay exact', () => {
	const days = [];
	const hours = [];
	for (let i = 0; i < 14; i++) {
		const date = C.addDays('2026-09-28', i);
		days.push({ date, dayTips: 33333 + i, totalTips: 100001 + i * 7 });
		hours.push(h(date, 'a', 'day', 333), h(date, 'b', 'day', 517), h(date, 'b', 'night', 600), h(date, 'c', 'night', 425));
	}
	const s = C.summarize({ serverPct: 60, servers, days, hours }, '2026-09-28', '2026-10-11');
	assert.equal(s.totals.serverTips + s.totals.leftover + s.totals.kitchen, s.totals.tips);
	assert.equal(s.rows.reduce((a, r) => a + r.tips, 0), s.totals.serverTips);
	assert.equal(s.totals.serverDayTips + s.totals.serverNightTips, s.totals.serverTips);
	assert.ok(s.rows.every((r) => r.dayTips % 100 === 0 && r.nightTips % 100 === 0), 'whole dollars');
	assert.ok(s.totals.leftover >= 0);
	assert.equal(s.days.length, 14);
});

// Exact shares in dollars → weights at pct 100 so tips (cents) = sum of weights.
function wd(sharesCents) {
	const entries = sharesCents.map((w, i) => ({ key: 'p' + i, weight: w }));
	const tips = sharesCents.reduce((a, b) => a + b, 0);
	const out = C.splitWholeDollars(tips, 100, entries);
	return entries.map((e) => out[e.key] / 100);
}

test("rounding rule: 50.50 / 60.70 / 60.70 / 40.10 → round the 60.70s up, total never above the pool", () => {
	// Pool $212.00. Rounding all of .50+ up would pay 51+61+61+40 = 213 > 212.
	assert.deepEqual(wd([5050, 6070, 6070, 4010]), [50, 61, 61, 40]);
});

test('rounding rule: same fraction (same hours) → both up or neither; the next fraction gets the dollar', () => {
	// Pool $211.90 → at most $211; only $1 spare and two people tie at .70 → the .40 gets it.
	assert.deepEqual(wd([5040, 6070, 6070, 4010]), [51, 60, 60, 40]);
	assert.deepEqual(wd([5050, 6070, 6070, 4000]), [51, 60, 60, 40]);
	// Below .50 is rounded up too when a dollar is spare (pool $101 → nothing left over).
	assert.deepEqual(wd([5040, 5040, 20]), [50, 50, 1]);
	assert.deepEqual(wd([5030, 5030, 5030, 1020]), [50, 50, 50, 11]); // pool $161.10, 2 tied short of 3
	// Only a tied group too big for the spare dollars is left: nobody goes up ($1 left over).
	assert.deepEqual(wd([5050, 5050]), [50, 50]);
	assert.deepEqual(wd([3340, 3330, 3330]), [34, 33, 33]); // pool $100: .40 first, the tied .30s skip
});

test('rounding rule: a shift leaves under $1 unless only a tied group is left', () => {
	for (let tips = 0; tips < 80000; tips += 61) {
		const entries = [{ key: 'a', weight: 700 }, { key: 'b', weight: 550 }, { key: 'c', weight: 425 }, { key: 'd', weight: 310 }];
		const r = C.splitShift(tips, 60, entries);
		assert.ok(r.leftover < 100, tips + ': leftover ' + r.leftover);
	}
});

test('rounding rule: whole dollars, never above the pool, through splitShift', () => {
	for (let tips = 0; tips < 60000; tips += 137) {
		const entries = [{ key: 'a', weight: 333 }, { key: 'b', weight: 333 }, { key: 'c', weight: 517 }, { key: 'd', weight: 50 }];
		const r = C.splitShift(tips, 60, entries);
		const paid = Object.values(r.shares).reduce((a, b) => a + b, 0);
		assert.equal(r.paid, paid);
		assert.ok(Object.values(r.shares).every((c) => c % 100 === 0), 'whole dollars');
		assert.ok(paid <= r.pool, 'never above the servers\' pool');
		assert.equal(r.shares.a, r.shares.b, 'same hours → same pay');
		assert.equal(paid + r.leftover + r.kitchen, tips);
		// Each person gets the whole dollars of their exact share, or one dollar more.
		for (const e of entries) {
			const exact = tips * 60 * e.weight / 100 / 1233;
			assert.ok(r.shares[e.key] <= Math.ceil(exact / 100) * 100 && r.shares[e.key] >= Math.floor(exact / 100) * 100);
		}
	}
});

test('missing whole-day total and tips with no hours are warned, never lost', () => {
	const s = C.summarize({
		serverPct: 60,
		servers,
		days: [
			{ date: '2026-10-01', dayTips: 10000, totalTips: null },
			{ date: '2026-10-02', dayTips: 5000, totalTips: 5000 },
		],
		hours: [h('2026-10-01', 'a', 'night', 500)],
	}, '2026-10-01', '2026-10-31');
	assert.deepEqual(s.warnings.map((w) => w.type + ':' + w.date), [
		'missingTotal:2026-10-01', 'noHours:2026-10-01', 'noHours:2026-10-02',
	]);
	assert.equal(s.totals.unallocated, 6000 + 3000);
	assert.equal(s.totals.pool, s.totals.serverTips + s.totals.unallocated);
});

test('per-server daily breakdown matches the per-person totals', () => {
	const days = [];
	const hours = [];
	for (let i = 0; i < 15; i++) {
		const date = C.addDays('2026-10-01', i);
		days.push({ date, dayTips: 20000 + i * 101, totalTips: 61003 + i * 7 });
		if (i % 3) hours.push(h(date, 'a', 'day', 450));
		hours.push(h(date, 'b', 'day', 525), h(date, 'b', 'night', 600), h(date, 'c', 'night', 375 + i));
	}
	const s = C.summarize({ serverPct: 60, servers, days, hours }, '2026-10-01', '2026-10-15');
	for (const r of s.rows) {
		const list = s.serverDays[r.id];
		const sum = (k) => list.reduce((a, d) => a + d[k], 0);
		assert.equal(sum('hours'), r.hours, r.name + ' hours');
		assert.equal(sum('dayHours'), r.dayHours);
		assert.equal(sum('nightHours'), r.nightHours);
		assert.equal(sum('tips'), r.tips, r.name + ' tips');
		assert.deepEqual(list.map((d) => d.date), [...list.map((d) => d.date)].sort());
	}
	assert.equal(s.serverDays.a.length, 10); // Alice skipped every third day
	assert.equal(s.serverDays.a[0].date, '2026-10-02');
	assert.equal(s.serverDays.c[0].nightHours, 375);
	// Per day: paid = what servers got that day; per hour = paid / that day's hours.
	for (const d of s.days) {
		const paid = s.rows.reduce((a, r) => a + (s.serverDays[r.id].find((x) => x.date === d.date) || { tips: 0 }).tips, 0);
		assert.equal(d.paid, paid, d.date + ' paid');
		assert.equal(d.paid + d.leftover, d.pool, d.date + ' paid + leftover = pool');
		assert.equal(d.perHourCents, Math.round(d.paid * 100 / (d.dayHours + d.nightHours)));
	}
});

test('per-day staff list: who worked, their hours and tips, in name order', () => {
	const s = C.summarize({
		serverPct: 60,
		servers,
		days: [
			{ date: '2026-10-01', dayTips: 50000, totalTips: 150000 },
			{ date: '2026-10-02', dayTips: 10000, totalTips: null },
			{ date: '2026-10-03', dayTips: 0, totalTips: 0 },
		],
		hours: [
			// Entered out of order on purpose: the list still comes out Alice, Bob, Chris.
			h('2026-10-01', 'c', 'night', 200),
			h('2026-10-01', 'a', 'day', 600), h('2026-10-01', 'a', 'night', 500),
			h('2026-10-01', 'b', 'day', 400), h('2026-10-01', 'b', 'night', 500),
			h('2026-10-02', 'b', 'day', 300), h('2026-10-02', 'c', 'night', 400),
			h('2026-10-02', 'gone', 'day', 100),
		],
	}, '2026-10-01', '2026-10-31');
	const [d1, d2, d3] = s.days;
	// README example: day $300 → Alice 6h $180, Bob 4h $120; night $600 → 5h $250, 5h $250, 2h $100.
	assert.deepEqual(d1.staff.map((x) => [x.id, x.name, x.dayHours, x.dayTips, x.nightHours, x.nightTips, x.hours, x.tips]), [
		['a', 'Alice', 600, 18000, 500, 25000, 1100, 43000],
		['b', 'Bob', 400, 12000, 500, 25000, 900, 37000],
		['c', 'Chris', 0, 0, 200, 10000, 200, 10000],
	]);
	assert.equal(d1.staff[0].perHourCents, Math.round(43000 * 100 / 1100));
	// A removed server comes last with no name; night tips are $0 while the total is missing.
	assert.deepEqual(d2.staff.map((x) => [x.id, x.name, x.tips, x.nightHours]), [
		['b', 'Bob', 4500, 0], ['c', 'Chris', 0, 400], ['gone', null, 1500, 0],
	]);
	assert.deepEqual(d3.staff, []);
	// Matches the per-person view and what servers were paid that day.
	for (const d of s.days) {
		assert.equal(d.staff.reduce((a, x) => a + x.tips, 0), d.paid, d.date + ' paid');
		assert.equal(d.staff.reduce((a, x) => a + x.hours, 0), d.dayHours + d.nightHours);
		for (const x of d.staff) {
			const sd = s.serverDays[x.id].find((y) => y.date === d.date);
			assert.equal(sd.tips, x.tips);
			assert.equal(sd.hours, x.hours);
		}
	}
});

test('range filter is inclusive', () => {
	const s = C.summarize({
		serverPct: 60,
		servers,
		days: ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01'].map((date) => ({ date, dayTips: 100, totalTips: 100 })),
		hours: [],
	}, '2026-10-01', '2026-10-31');
	assert.equal(s.totals.tips, 200);
});

test('period and month helpers', () => {
	assert.deepEqual(C.payPeriodFor('2026-10-01'), { from: '2026-10-01', to: '2026-10-15' });
	assert.deepEqual(C.payPeriodFor('2026-10-15'), { from: '2026-10-01', to: '2026-10-15' });
	assert.deepEqual(C.payPeriodFor('2026-10-16'), { from: '2026-10-16', to: '2026-10-31' });
	assert.deepEqual(C.payPeriodFor('2026-09-30'), { from: '2026-09-16', to: '2026-09-30' });
	assert.deepEqual(C.payPeriodFor('2027-02-20'), { from: '2027-02-16', to: '2027-02-28' });
	assert.deepEqual(C.payPeriodFor('2028-02-29'), { from: '2028-02-16', to: '2028-02-29' });
	assert.deepEqual(C.shiftPayPeriod('2026-10-05', -1), { from: '2026-09-16', to: '2026-09-30' });
	assert.deepEqual(C.shiftPayPeriod('2026-10-05', 1), { from: '2026-10-16', to: '2026-10-31' });
	assert.deepEqual(C.shiftPayPeriod('2026-12-20', 1), { from: '2027-01-01', to: '2027-01-15' });
	assert.deepEqual(C.shiftPayPeriod('2026-01-03', -1), { from: '2025-12-16', to: '2025-12-31' });
	assert.deepEqual(C.shiftPayPeriod('2026-10-05', 0), { from: '2026-10-01', to: '2026-10-15' });
	assert.deepEqual(C.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
	assert.equal(C.shiftMonth('2026-01', -1), '2025-12');
});

test('servers are always listed alphabetically', () => {
	const names = (list) => C.sortServers(list.map((name, i) => ({ id: 'id' + i, name }))).map((s) => s.name);
	// Upper/lower case does not matter; a new server takes its place by name, not the end.
	assert.deepEqual(names(['Noriko', 'Masumi', 'ellen', 'Chika', 'adam']), ['adam', 'Chika', 'ellen', 'Masumi', 'Noriko']);
	// English before Korean, Korean in 가나다 order, numbers by value.
	assert.deepEqual(names(['김민수', 'Zoe', '가은', 'Server 10', 'Server 2']), ['Server 2', 'Server 10', 'Zoe', '가은', '김민수']);
	// The input list is not changed, and equal names keep a stable order (by id).
	const input = [{ id: 'b', name: 'Sam' }, { id: 'a', name: 'Sam' }];
	assert.deepEqual(C.sortServers(input).map((s) => s.id), ['a', 'b']);
	assert.equal(input[0].id, 'b');
});

test('report rows follow the (alphabetical) server list; removed servers come last', () => {
	const sorted = C.sortServers([{ id: 'n', name: 'Noriko' }, { id: 'a', name: 'adam' }, { id: 'c', name: 'Chika' }]);
	const s = C.summarize({
		serverPct: 60,
		servers: sorted,
		days: [{ date: '2026-10-01', dayTips: 30000, totalTips: 30000 }],
		hours: [h('2026-10-01', 'gone', 'day', 100), h('2026-10-01', 'n', 'day', 100), h('2026-10-01', 'c', 'day', 100), h('2026-10-01', 'a', 'day', 100)],
	}, '2026-10-01', '2026-10-15');
	assert.deepEqual(s.rows.map((r) => r.name), ['adam', 'Chika', 'Noriko', null]);
});
