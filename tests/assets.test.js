'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../scripts/stamp-assets.js');

const html = fs.readFileSync(S.INDEX, 'utf8');

test('index.html loads the stylesheet and every script', () => {
	const files = S.assets(html).map((a) => a.file);
	assert.ok(files.includes('css/style.css'));
	for (const f of fs.readdirSync(path.join(__dirname, '..', 'js'))) {
		assert.ok(files.includes('js/' + f), 'index.html does not load js/' + f);
	}
});

test('every css/js file in index.html has its current ?v= (run "npm run stamp")', () => {
	const stale = S.assets(html)
		.filter((a) => a.version !== S.versionOf(a.file))
		.map((a) => a.file);
	assert.deepEqual(stale, [], 'outdated ?v= — run "npm run stamp" and commit index.html');
});
