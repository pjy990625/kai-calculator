#!/usr/bin/env node
/*
 * Cache busting for GitHub Pages.
 *
 * Phones keep css/ and js/ files in their cache for a while after an update,
 * so they could run new JavaScript with an old stylesheet (or the other way
 * round). index.html therefore loads every local .css/.js file with
 * "?v=<first 10 hex chars of the file's SHA-256>": when a file changes, its
 * address changes and phones fetch the new one right away; unchanged files
 * stay cached.
 *
 *   npm run stamp           update index.html after changing css/ or js/
 *   (npm test checks that every ?v= matches, so a forgotten stamp fails CI)
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
// href="css/style.css" or src="js/app.js", with or without an existing ?v=…
// Groups: 1 attribute, 2 file, 3 current version (if any).
const ASSET = /\b(href|src)="((?:css|js)\/[\w.-]+\.(?:css|js))(?:\?v=([^"]*))?"/g;

function versionOf(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex').slice(0, 10);
}

/** index.html with every local asset pointing at its current version. */
function stamped(html) {
	return html.replace(ASSET, function (m, attr, file) {
		return attr + '="' + file + '?v=' + versionOf(file) + '"';
	});
}

/** Local assets index.html loads: [{ file, version }] (version null when missing). */
function assets(html) {
	return Array.from(html.matchAll(ASSET), function (m) {
		return { file: m[2], version: m[3] || null };
	});
}

module.exports = { versionOf: versionOf, stamped: stamped, assets: assets, INDEX: INDEX };

if (require.main === module) {
	const html = fs.readFileSync(INDEX, 'utf8');
	const next = stamped(html);
	if (next === html) {
		console.log('index.html is up to date.');
	} else {
		fs.writeFileSync(INDEX, next);
		console.log('index.html updated:');
		assets(next).forEach(function (a) { console.log('  ' + a.file + '?v=' + a.version); });
	}
}
