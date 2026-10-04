'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I = require('../js/i18n.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('Korean and English have exactly the same keys', () => {
	assert.deepEqual(Object.keys(I.STRINGS.ko).sort(), Object.keys(I.STRINGS.en).sort());
});

test('every t("key") used in app.js exists', () => {
	const used = [...read('js/app.js').matchAll(/\bt\('([A-Za-z_]+)'\s*[,)]/g)].map((m) => m[1]);
	assert.ok(used.length > 50);
	const missing = [...new Set(used)].filter((k) => !(k in I.STRINGS.en));
	assert.deepEqual(missing, []);
});

test('every database error code and login error has a message', () => {
	const sql = read('supabase/setup.sql');
	const codes = new Set([...sql.matchAll(/private\.fail\('([a-z_]+)'\)/g)].map((m) => m[1]));
	for (const m of sql.matchAll(/then '([a-z_]+)' else '([a-z_]+)' end\)/g)) {
		codes.add(m[1]);
		codes.add(m[2]);
	}
	assert.ok(codes.size > 10);
	for (const c of codes) {
		assert.ok('err_' + c in I.STRINGS.en, 'missing err_' + c);
	}
	const known = read('js/api.js');
	for (const c of codes) {
		assert.ok(known.includes("'" + c + "'"), 'api.js KNOWN is missing ' + c);
	}
	for (const m of sql.matchAll(/'error', '([a-z_]+)'/g)) {
		assert.ok('login_' + m[1] in I.STRINGS.en, 'missing login_' + m[1]);
	}
});

test('placeholders match between languages', () => {
	const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
	for (const k of Object.keys(I.STRINGS.en)) {
		assert.equal(vars(I.STRINGS.ko[k]), vars(I.STRINGS.en[k]), k);
	}
});
