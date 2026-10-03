'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/calc.js');

function data(shifts, settings) {
	return C.normalizeData({
		version: 1,
		settings: Object.assign({ periodAnchor: '2026-09-28', splitMode: 'perShift' }, settings || {}),
		servers: [
			{ id: 'a', name: 'Alice' },
			{ id: 'b', name: 'Bob' },
			{ id: 'c', name: 'Chris' },
		],
		shifts: shifts,
	});
}

test('parseMoney', () => {
	assert.equal(C.parseMoney('80'), 8000);
	assert.equal(C.parseMoney('80.5'), 8050);
	assert.equal(C.parseMoney('$1,234.56'), 123456);
	assert.equal(C.parseMoney('.5'), 50);
	assert.equal(C.parseMoney('0.07'), 7);
	assert.equal(C.parseMoney(''), null);
	assert.equal(C.parseMoney('abc'), null);
	assert.equal(C.parseMoney('1.234'), null);
	assert.equal(C.parseMoney('-5'), null);
});

test('parseHours', () => {
	assert.equal(C.parseHours('5'), 500);
	assert.equal(C.parseHours('5.5'), 550);
	assert.equal(C.parseHours('5,25'), 525);
	assert.equal(C.parseHours('5:30'), 550);
	assert.equal(C.parseHours('5:20'), 533);
	assert.equal(C.parseHours('24'), 2400);
	assert.equal(C.parseHours('25'), null);
	assert.equal(C.parseHours('5:75'), null);
	assert.equal(C.parseHours(''), null);
	assert.equal(C.formatHours(550), '5.5');
	assert.equal(C.formatHours(500), '5');
	assert.equal(C.formatHours(533), '5.33');
});

test('splitByWeight always sums to the total exactly', () => {
	const s = C.splitByWeight(10000, [{ key: 'a', weight: 100 }, { key: 'b', weight: 100 }, { key: 'c', weight: 100 }]);
	assert.deepEqual(s, { a: 3334, b: 3333, c: 3333 });

	for (let i = 0; i < 2000; i++) {
		const total = Math.floor(Math.random() * 500000);
		const n = 1 + Math.floor(Math.random() * 10);
		const entries = [];
		for (let k = 0; k < n; k++) {
			entries.push({ key: 'k' + k, weight: 1 + Math.floor(Math.random() * 1200) });
		}
		const out = C.splitByWeight(total, entries);
		assert.equal(Object.values(out).reduce((x, y) => x + y, 0), total);
	}
});

test('splitByWeight is proportional to hours', () => {
	// $90 for 6h vs 3h → $60 / $30
	assert.deepEqual(C.splitByWeight(9000, [{ key: 'a', weight: 600 }, { key: 'b', weight: 300 }]), { a: 6000, b: 3000 });
});

test('period and month helpers', () => {
	assert.deepEqual(C.periodFor('2026-09-28', '2026-10-03'), { from: '2026-09-28', to: '2026-10-11' });
	assert.deepEqual(C.periodFor('2026-09-28', '2026-10-12'), { from: '2026-10-12', to: '2026-10-25' });
	assert.deepEqual(C.periodFor('2026-09-28', '2026-09-27'), { from: '2026-09-14', to: '2026-09-27' });
	// across a DST change (US: 2026-11-01)
	assert.deepEqual(C.periodFor('2026-10-26', '2026-11-08'), { from: '2026-10-26', to: '2026-11-08' });
	assert.deepEqual(C.monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
	assert.deepEqual(C.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
	assert.equal(C.shiftMonth('2026-01', -1), '2025-12');
	assert.equal(C.shiftMonth('2026-12', 1), '2027-01');

	const ps = C.periodsInRange('2026-09-28', '2026-10-01', '2026-10-31');
	assert.deepEqual(ps.map((p) => [p.from, p.to, p.partial]), [
		['2026-10-01', '2026-10-11', true],
		['2026-10-12', '2026-10-25', false],
		['2026-10-26', '2026-10-31', true],
	]);
});

test('summarize perShift: each shift split by its own hours', () => {
	const d = data([
		{ date: '2026-10-01', type: 'day', tipsCents: 9000, hours: { a: 600, b: 300 } },
		{ date: '2026-10-01', type: 'night', tipsCents: 20000, hours: { b: 500, c: 500 } },
		{ date: '2026-10-02', type: 'day', tipsCents: 10000, hours: { a: 400, c: 400 } },
	]);
	const s = C.summarize(d, '2026-10-01', '2026-10-31');
	const by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
	assert.equal(by.Alice.dayTips, 6000 + 5000);
	assert.equal(by.Alice.dayHours, 1000);
	assert.equal(by.Bob.dayTips, 3000);
	assert.equal(by.Bob.nightTips, 10000);
	assert.equal(by.Chris.dayTips, 5000);
	assert.equal(by.Chris.nightTips, 10000);
	assert.equal(by.Bob.hours, 800);
	assert.equal(by.Bob.tips, 13000);
	assert.equal(by.Bob.perHourCents, 1625);
	assert.equal(s.totals.tips, 39000);
	assert.equal(s.unallocatedCents, 0);
	assert.deepEqual(s.rows.map((r) => r.name), ['Alice', 'Bob', 'Chris']);
});

test('summarize pooled: whole-range pool split by total hours', () => {
	const shifts = [
		{ date: '2026-10-01', type: 'day', tipsCents: 9000, hours: { a: 600, b: 300 } },
		{ date: '2026-10-02', type: 'day', tipsCents: 3000, hours: { b: 300 } },
	];
	const s = C.summarize(data(shifts, { splitMode: 'pooled' }), '2026-10-01', '2026-10-31');
	const by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
	// pool 12000 over 600 + 600 hours → 6000 each
	assert.equal(by.Alice.dayTips, 6000);
	assert.equal(by.Bob.dayTips, 6000);

	const p = C.summarize(data(shifts), '2026-10-01', '2026-10-31');
	const byp = Object.fromEntries(p.rows.map((r) => [r.name, r]));
	assert.equal(byp.Alice.dayTips, 6000);
	assert.equal(byp.Bob.dayTips, 6000);
});

test('tips with nobody on shift are reported, never dropped', () => {
	const d = data([
		{ date: '2026-10-01', type: 'night', tipsCents: 5000, hours: {} },
		{ date: '2026-10-02', type: 'night', tipsCents: 1001, hours: { a: 300, b: 300, c: 300 } },
	]);
	const s = C.summarize(d, '2026-10-01', '2026-10-31');
	assert.equal(s.unallocatedCents, 5000);
	assert.equal(s.totals.tips + s.unallocatedCents, 6001);
});

test('range filter is inclusive and excludes outside dates', () => {
	const d = data([
		{ date: '2026-09-30', type: 'day', tipsCents: 100, hours: { a: 100 } },
		{ date: '2026-10-01', type: 'day', tipsCents: 200, hours: { a: 100 } },
		{ date: '2026-10-31', type: 'day', tipsCents: 400, hours: { a: 100 } },
		{ date: '2026-11-01', type: 'day', tipsCents: 800, hours: { a: 100 } },
	]);
	assert.equal(C.summarize(d, '2026-10-01', '2026-10-31').totals.tips, 600);
});

test('normalizeData repairs bad input and rejects non-data', () => {
	assert.throws(() => C.normalizeData(null));
	assert.throws(() => C.normalizeData([]));
	assert.throws(() => C.normalizeData({ version: 99, servers: [], shifts: [] }));
	const d = C.normalizeData({
		settings: { currency: 'XXX', periodAnchor: '2026-02-30', splitMode: 'weird' },
		servers: [{ id: 'a', name: '  Al  ice ' }, { id: 'a', name: 'dup' }, { id: 'b', name: '' }],
		shifts: [
			{ date: '2026-10-01', type: 'day', tipsCents: 100, hours: { a: 100, zzz: 100, b: 100 } },
			{ date: '2026-10-01', type: 'day', tipsCents: 200, hours: { a: 200 } },
			{ date: 'bad', type: 'day', tipsCents: 1, hours: {} },
			{ date: '2026-10-02', type: 'lunch', tipsCents: 1, hours: {} },
			{ date: '2026-10-02', type: 'day', tipsCents: 1.5, hours: {} },
		],
	});
	assert.equal(d.settings.currency, 'USD');
	assert.equal(d.settings.periodAnchor, '2026-01-05');
	assert.equal(d.settings.splitMode, 'perShift');
	assert.deepEqual(d.servers, [{ id: 'a', name: 'Al ice', active: true }]);
	assert.equal(d.shifts.length, 1);
	assert.equal(d.shifts[0].tipsCents, 200);
});

test('share link round-trips, including non-ASCII names', () => {
	const d = data([
		{ date: '2026-10-01', type: 'day', tipsCents: 12345, hours: { a: 550, b: 325 } },
	]);
	d.servers[0].name = '김카이 🍜';
	const s = C.summarize(d, '2026-10-01', '2026-10-31');
	const view = {
		title: 'Kai',
		currency: 'CAD',
		lang: 'ko',
		kind: 'month',
		mode: 'perShift',
		from: s.from,
		to: s.to,
		generatedAt: '2026-10-03T10:00:00.000Z',
		rows: s.rows,
		unallocatedCents: 0,
		sections: [{ from: '2026-10-01', to: '2026-10-11', partial: true, rows: s.rows, unallocatedCents: 0 }],
	};
	const enc = C.encodeShare(C.buildSharePayload(view));
	assert.match(enc, /^[A-Za-z0-9_-]+$/);
	const back = C.viewFromSharePayload(C.decodeShare(enc));
	assert.equal(back.rows[0].name, '김카이 🍜');
	assert.equal(back.totals.tips, 12345);
	assert.equal(back.currency, 'CAD');
	assert.equal(back.sections[0].partial, true);
	assert.throws(() => C.viewFromSharePayload({ v: 1, f: 'x' }));
	assert.throws(() => C.viewFromSharePayload(Object.assign(C.buildSharePayload(view), { r: [['x', -1, 0, 0, 0]] })));
});
