import test from 'node:test';
import assert from 'node:assert/strict';
import { chartIndexAtX } from '../../chat/components/chartInteractions.js';
import { renderChartArtifact } from '../../chat/components/chartSvg.js';

const spec = { chartType: 'line', title: 'Rates', xLabels: ['2011', '2012', '2013'],
    series: [{ name: 'A', values: [1.001, 0, -2] }, { name: 'B', values: [3, 4, 5] }] };
test('line inspection snaps to nearest category and clamps endpoints', () => {
    for (const [x, expected] of [[0, 0], [56, 0], [197, 0], [199, 1], [340, 1], [624, 2], [900, 2]]) {
        assert.equal(chartIndexAtX(spec, x), expected);
    }
    assert.equal(chartIndexAtX({ ...spec, xLabels: ['only'] }, 624), 0);
});
test('grouped bar inspection uses category bands rather than line spacing', () => {
    for (const [x, expected] of [[56, 0], [240, 0], [250, 1], [430, 1], [440, 2], [624, 2]]) {
        assert.equal(chartIndexAtX({ ...spec, chartType: 'bar' }, x), expected);
    }
});
test('inspection survives rendering with exact values, focus instructions and hidden status', () => {
    const html = renderChartArtifact({ spec });
    assert.match(html, /tabindex="0" role="group"/);
    assert.match(html, /Use Left and Right arrow keys/);
    assert.match(html, /role="status" aria-live="polite" aria-atomic="true" hidden/);
    assert.match(html, /oa-chart-hit-area/);
    const encoded = html.match(/data-chart-spec="([^"]+)"/)[1];
    assert.deepEqual(JSON.parse(encoded.replace(/&quot;/g, '"')), spec);
});
