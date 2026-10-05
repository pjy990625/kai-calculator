/*
 * Kai Calculator — small fallbacks for older phones. Loaded before every other
 * script so all of them can rely on these.
 */
(function () {
	'use strict';

	// iOS < 14 and Chrome < 86 lack Element.replaceChildren.
	if (!Element.prototype.replaceChildren) {
		Element.prototype.replaceChildren = function () {
			while (this.firstChild) {
				this.removeChild(this.firstChild);
			}
			for (let i = 0; i < arguments.length; i++) {
				const n = arguments[i];
				this.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
			}
		};
	}
}());
