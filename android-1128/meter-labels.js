/* Display only: fixed guide labels and active register text never overlap. */
(function (root) {
  'use strict';
  const labels = new Set(['地声', 'ミックス', '裏声', '裏声orミックス']);
  root.PMMeterLabels = Object.freeze({
    active(label, opacity) { return opacity > 0.01 && labels.has(label); }
  });
})(typeof self !== 'undefined' ? self : this);
