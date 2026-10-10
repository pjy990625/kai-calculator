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
	// Phone keyboards that type a comma as the decimal point
	assert.equal(C.parseMoney('12,50'), 1250);
	assert.equal(C.parseMoney('12,5'), 1250);
	assert.equal(C.parseMoney('1,234'), 123400);
	assert.equal(C.parseMoney('12,345.67'), 1234567);
});

test('parseHours / formatHours', () => {
	assert.equal(C.parseHours('5'), 500);
	assert.equal(C.parseHours('5.5'), 550);
	assert.equal(C.parseHours('5:30'), 550);
	assert.equal(C.parseHours('5:20'), 533);
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

test('rounding rule: same fraction (same hours) → both up or neither', () => {
	// Pool $211.90 → at most $211; only $1 spare but two people tie at .70 → nobody goes up.
	assert.deepEqual(wd([5040, 6070, 6070, 4010]), [50, 60, 60, 40]);
	// A smaller fraction (50.50) never jumps ahead of a tied group that did not fit.
	assert.deepEqual(wd([5050, 6070, 6070, 4000]), [50, 60, 60, 40]);
	// Below .50 always rounds down, even when there is room.
	assert.deepEqual(wd([5040, 5040, 20]), [50, 50, 0]); // pool $101, $1 left over
});

test('rounding rule: whole dollars, never above the pool, through splitShift', () => {
	for (let tips = 0; tips < 60000; tips += 137) {
		const entries = [{ key: 'a', weight: 333 }, { key: 'b', weight: 333 }, { key: 'c', weight: 517 }, { key: 'd', weight: 50 }];
		const r = C.splitShift(tips, 60, entries);
		const paid = Object.values(r.shares).reduce((a, b) => a + b, 0);
		assert.equal(r.paid, paid);
		assert.ok(Object.values(r.shares).every((c) => c % 100 === 0), 'whole dollars');
		assert.ok(paid * 100 <= tips * 60, 'never above 60% of the tips');
		assert.equal(r.shares.a, r.shares.b, 'same hours → same pay');
		assert.equal(paid + r.leftover + r.kitchen, tips);
		// Each person is within $1 of their exact share, and rounding only goes up from .50.
		for (const e of entries) {
			const exact = tips * 60 * e.weight / 100 / 1233;
			assert.ok(r.shares[e.key] <= Math.round(exact / 100) * 100 && r.shares[e.key] >= Math.floor(exact / 100) * 100);
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
