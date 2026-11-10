import test from 'node:test';
import assert from 'node:assert/strict';
import { formatChartNumber, niceTicks, renderChartArtifact, renderChartPlaceholder } from '../../chat/components/chartSvg.js';

const artifact = spec => ({ version: 1, type: 'chart', spec });
const BAR = { chartType: 'bar', title: 'Spend by month', xLabels: ['Jan', 'Feb', 'Mar'],
    series: [{ name: 'Food', values: [120, 80, 95] }, { name: 'Travel', values: [40, 0, -15] }], yAxisTitle: 'USD' };

test('nice ticks are round, cover the range, and include zero for bars', () => {
    assert.deepEqual(niceTicks(0, 95), [0, 20, 40, 60, 80, 100]);
    assert.deepEqual(niceTicks(-15, 120), [-50, 0, 50, 100, 150]);
    assert.deepEqual(niceTicks(0.1, 0.9), [0, 0.2, 0.4, 0.6, 0.8, 1]);
    assert.deepEqual(niceTicks(5, 5), [0, 5]);
    assert.deepEqual(niceTicks(0, 0), [0, 1]);
    assert.deepEqual(niceTicks(1200, 9800), [0, 2000, 4000, 6000, 8000, 10000]);
});

test('numbers are abbreviated for axis space', () => {
    assert.equal(formatChartNumber(1234567), '1.2M');
    assert.equal(formatChartNumber(2500000000), '2.5B');
    assert.equal(formatChartNumber(15000), '15k');
    assert.equal(formatChartNumber(999), '999');
    assert.equal(formatChartNumber(12.345), '12.3');
    assert.equal(formatChartNumber(0.456), '0.46');
    assert.equal(formatChartNumber(-15), '-15');
    assert.equal(formatChartNumber(NaN), '');
});

test('a bar chart renders one mark per value, a legend, titles and a data table', () => {
    const html = renderChartArtifact(artifact(BAR), { messageId: 'm1' });
    assert.match(html, /<figure class="oa-chart-card" data-chart-type="bar" data-chart-message-id="m1">/);
    assert.match(html, /<figcaption class="oa-chart-title">Spend by month<\/figcaption>/);
    assert.equal((html.match(/class="oa-chart-bar"/g) || []).length, 6);
    assert.equal((html.match(/fill="var\(--oa-chart-1\)"/g) || []).length, 3);
    assert.equal((html.match(/fill="var\(--oa-chart-2\)"/g) || []).length, 3);
    assert.match(html, /<title>Travel · Mar: -15<\/title>/);
    assert.match(html, /<ul class="oa-chart-legend"[^>]*>(<li>.*?<\/li>){2}<\/ul>/);
    assert.match(html, /oa-chart-axis-title[^>]*>USD</);
    assert.match(html, /<details class="oa-chart-data"><summary>Show data<\/summary>/);
    assert.match(html, /<th scope="row">Feb<\/th><td>80<\/td><td>0<\/td>/);
    assert.match(html, /class="oa-chart-baseline"/);
    assert.match(html, /role="img" aria-label="Spend by month"/);
});

test('a single-series chart has no legend', () => {
    const html = renderChartArtifact(artifact({ ...BAR, series: [BAR.series[0]] }));
    assert.doesNotMatch(html, /oa-chart-legend/);
});

test('a line chart draws one path per series and markers only for short series', () => {
    const short = renderChartArtifact(artifact({ ...BAR, chartType: 'line' }));
    assert.equal((short.match(/class="oa-chart-line"/g) || []).length, 2);
    assert.equal((short.match(/class="oa-chart-marker"/g) || []).length, 6);
    const n = 200;
    const long = renderChartArtifact(artifact({ chartType: 'line', title: 'Long', xLabels: Array.from({ length: n }, (_, i) => `d${i}`),
        series: [{ name: 'S', values: Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 100 + 500) }] }));
    assert.equal((long.match(/class="oa-chart-marker"/g) || []).length, 0);
    // Crowded axes thin their labels rather than overlapping them.
    assert.ok((long.match(/class="oa-chart-tick" x="[^"]+" y="27[0-9][^"]*" text-anchor="middle"/g) || []).length <= 13);
});

test('a pie chart renders slices with percentages and labels the legend by category', () => {
    const html = renderChartArtifact(artifact({ chartType: 'pie', title: 'Share', xLabels: ['A', 'B', 'C', 'Tiny'],
        series: [{ name: 'Share', values: [50, 30, 19, 1] }] }));
    assert.equal((html.match(/class="oa-chart-slice"/g) || []).length, 4);
    assert.match(html, /<title>A: 50 \(50%\)<\/title>/);
    assert.match(html, />50%</);
    assert.match(html, />19%</);
    assert.doesNotMatch(html, />1%</);
    assert.match(html, /oa-chart-legend[\s\S]*Tiny/);
    const whole = renderChartArtifact(artifact({ chartType: 'pie', title: 'All', xLabels: ['Only'], series: [{ name: 'S', values: [7] }] }));
    assert.equal((whole.match(/class="oa-chart-slice"/g) || []).length, 1);
    const empty = renderChartArtifact(artifact({ chartType: 'pie', title: 'Zero', xLabels: ['A'], series: [{ name: 'S', values: [0] }] }));
    assert.match(empty, /No non-zero values/);
});

test('every string from the spec is escaped and nothing from it reaches an attribute unescaped', () => {
    const hostile = '"><img src=x onerror=alert(1)> <script>x</script>';
    const html = renderChartArtifact(artifact({ chartType: 'bar', title: hostile, xLabels: [hostile], series: [{ name: hostile, values: [1] }],
        xAxisTitle: hostile, yAxisTitle: hostile }), { messageId: hostile });
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img /);
    // Every '<' in the output opens one of our own tags; none comes from the spec.
    for (const tag of html.match(/<\/?[a-zA-Z][^\s>\/]*/g)) assert.ok(/^<\/?(figure|figcaption|svg|g|rect|line|text|path|title|ul|li|span|details|summary|div|table|thead|tbody|tr|th|td)$/.test(tag), tag);
    assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
});

test('an artifact that does not validate renders nothing', () => {
    assert.equal(renderChartArtifact(artifact({ chartType: 'bar', title: 'x', xLabels: ['a'], series: [{ name: 's', values: ['nope'] }] })), '');
    assert.equal(renderChartArtifact(null), '');
    assert.equal(renderChartArtifact({ version: 1, type: 'chart' }), '');
});

test('the placeholder is a busy figure with no data', () => {
    const html = renderChartPlaceholder();
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /oa-chart-card-pending/);
    assert.doesNotMatch(html, /<svg/);
});


test('finite extreme and adjacent values render bounded axes and finite geometry', () => {
    for (const values of [[1, 1 + Number.EPSILON], [1e-12, 2e-12],
        [-1e308, 1e308], [1e308, 1.1e308], [Number.MIN_VALUE, Number.MIN_VALUE * 2]]) {
        const ticks = niceTicks(...values);
        assert.ok(ticks.length >= 2 && ticks.length <= 21);
        assert.ok(ticks.every(Number.isFinite));
        assert.ok(ticks[0] <= values[0] && ticks.at(-1) >= values[1]);
        for (const chartType of ['bar', 'line']) {
            const html = renderChartArtifact(artifact({ chartType, title: 'Range', xLabels: ['A', 'B'],
                series: [{ name: 'S', values }] }));
            assert.doesNotMatch(html, /NaN|Infinity/);
            if (chartType === 'line') {
                const ys = [...html.matchAll(/cy="([^"]+)"/g)].map(match => Number(match[1]));
                assert.equal(ys.length, 2);
                assert.ok(ys[0] > ys[1], 'distinct values keep their vertical ordering');
            }
        }
    }
});

test('pie weights do not overflow and the data table retains exact values', () => {
    const pie = renderChartArtifact(artifact({ chartType: 'pie', title: 'Large', xLabels: ['A', 'B'],
        series: [{ name: 'S', values: [1e308, 1e308] }] }));
    assert.equal((pie.match(/>50%<\/text>/g) || []).length, 2);
    assert.doesNotMatch(pie, /NaN|Infinity/);
    const bar = renderChartArtifact(artifact({ chartType: 'bar', title: 'Exact', xLabels: ['A', 'B'],
        series: [{ name: 'S', values: [412.49, 0.004] }] }));
    assert.match(bar, /<td>412\.49<\/td>/);
    assert.match(bar, /<td>0\.004<\/td>/);
    assert.match(bar, /<title>S · B: 0\.004<\/title>/);
});


test('missing points split lines without inventing zeros or moving the remaining categories', () => {
    const spec = { chartType: 'line', title: 'Forecast', xLabels: ['Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        series: [{ name: 'High', values: [null, 7, null, 5, 4] }] };
    const html = renderChartArtifact({ version: 1, type: 'chart', spec });
    const d = html.match(/class="oa-chart-line" d="([^"]+)"/)[1];
    assert.equal((d.match(/M/g) || []).length, 2);
    assert.equal((d.match(/L/g) || []).length, 1);
    assert.equal((html.match(/class="oa-chart-marker"/g) || []).length, 3);
    assert.match(html, /High · Wed: 7/);
    assert.equal((html.match(/<td>Not available<\/td>/g) || []).length, 2);
    assert.doesNotMatch(html, /(?:cy|d)="[^"]*(?:NaN|Infinity|null)/);
    const bars = renderChartArtifact({ spec: { ...spec, chartType: 'bar' } });
    assert.equal((bars.match(/class="oa-chart-bar"/g) || []).length, 3);
});

test('a dense line keeps isolated known points visible between gaps', () => {
    const values = Array(100).fill(null); values[50] = 8;
    const html = renderChartArtifact({ spec: { chartType: 'line', title: 'Sparse',
        xLabels: values.map((_, i) => String(i)), series: [{ name: 'Known', values }] } });
    assert.equal((html.match(/class="oa-chart-marker"/g) || []).length, 1);
    assert.match(html, /Known · 50: 8/);
});
