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

test('splitByWeight always sums to the total exactly', () => {
	assert.deepEqual(C.splitByWeight(10000, [{ key: 'a', weight: 1 }, { key: 'b', weight: 1 }, { key: 'c', weight: 1 }]),
		{ a: 3334, b: 3333, c: 3333 });
	for (let i = 0; i < 2000; i++) {
		const total = Math.floor(Math.random() * 500000);
		const entries = Array.from({ length: 1 + Math.floor(Math.random() * 10) },
			(_, k) => ({ key: 'k' + k, weight: 1 + Math.floor(Math.random() * 1200) }));
		const out = C.splitByWeight(total, entries);
		assert.equal(Object.values(out).reduce((x, y) => x + y, 0), total);
	}
});

test('serverPool is 60% rounded half-up; kitchen gets exactly the rest', () => {
	assert.equal(C.serverPool(10000, 60), 6000);
	assert.equal(C.serverPool(10001, 60), 6001); // 6000.6 → 6001
	assert.equal(C.serverPool(10002, 60), 6001); // 6001.2 → 6001
	for (let t = 0; t < 5000; t++) {
		const s = C.splitShift(t, 60, [{ key: 'a', weight: 300 }, { key: 'b', weight: 700 }]);
		assert.equal(s.pool + s.kitchen, t);
		assert.equal(s.shares.a + s.shares.b, s.pool);
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
	assert.equal(s.totals.serverTips + s.totals.kitchen, s.totals.tips);
	assert.equal(s.rows.reduce((a, r) => a + r.tips, 0), s.totals.pool);
	assert.equal(s.days.length, 14);
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
	assert.deepEqual(C.periodFor('2026-09-28', '2026-10-03'), { from: '2026-09-28', to: '2026-10-11' });
	assert.deepEqual(C.periodFor('2026-09-28', '2026-09-27'), { from: '2026-09-14', to: '2026-09-27' });
	assert.deepEqual(C.periodFor('2026-10-26', '2026-11-08'), { from: '2026-10-26', to: '2026-11-08' });
	assert.deepEqual(C.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
	assert.equal(C.shiftMonth('2026-01', -1), '2025-12');
});
