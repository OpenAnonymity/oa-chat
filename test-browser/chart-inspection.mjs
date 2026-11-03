import { renderChartArtifact } from '../chat/components/chartSvg.js';
import { installChartInteractions } from '../chat/components/chartInteractions.js';

const spec = { chartType: 'line', title: 'Output by region', xLabels: ['2011', '2012', '2013', '2014'],
    yAxisTitle: 'Trillion USD', series: [{ name: 'United States', values: [15.6, 16.25, 16.84, 17.55] },
        { name: 'European Union (EU-27)', values: [14.62, 14.73, 15.09, 15.61] },
        { name: 'China', values: [7.55, 8.67, 9.62, 10.52] }] };
const fixture = document.querySelector('#fixture');
fixture.innerHTML = renderChartArtifact({ spec }) + renderChartArtifact({ spec: { ...spec, chartType: 'bar', title: 'Grouped bars' } }) +
    `<div style="width:300px;max-width:100%">${renderChartArtifact({ spec: { ...spec, title: 'Narrow card' } })}</div>` +
    renderChartArtifact({ spec: { chartType: 'pie', title: 'Share', xLabels: ['A', 'B'], series: [{ name: 'Count', values: [30, 70] }] } });
const dispose = installChartInteractions(document);
const plots = fixture.querySelectorAll('.oa-chart-plot');
const [line, bar, narrow, pie] = plots;
let checks = 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
const key = (plot, value) => plot.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
const tip = plot => plot.querySelector('.oa-chart-tooltip');
const pointer = (plot, type, x, y, pointerType = 'mouse') => {
    const svg = plot.querySelector('svg');
    const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
    const pos = pt.matrixTransform(svg.getScreenCTM());
    svg.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, pointerId: 1, clientX: pos.x, clientY: pos.y }));
};
try {
    assert(installChartInteractions(document) === dispose, 'duplicate installation');
    line.focus(); key(line, 'ArrowRight');
    assert(tip(line).textContent.includes('2012') && tip(line).textContent.includes('16.25') && tip(line).textContent.includes('14.73') && tip(line).textContent.includes('8.67'), 'all exact series values');
    assert(line.querySelectorAll('.oa-chart-active-point').length === 3, 'active points');
    key(line, 'End'); assert(tip(line).textContent.includes('2014'), 'End');
    key(line, 'Home'); assert(tip(line).textContent.includes('2011'), 'Home');
    key(line, 'Escape'); assert(tip(line).hidden, 'Escape hides');
    pointer(line, 'pointermove', 245, 100); assert(tip(line).hidden, 'Escape stays dismissed until re-entry');
    line.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body, pointerType: 'mouse' }));
    pointer(line, 'pointermove', 245, 100); assert(tip(line).textContent.includes('2012') && !tip(line).hidden, 'responsive pointer mapping');
    pointer(bar, 'pointermove', 200, 100); assert(tip(bar).textContent.includes('2012') && tip(line).hidden, 'bar band + independent cards');
    pointer(narrow, 'pointerdown', 245, 100, 'touch'); pointer(narrow, 'pointerup', 245, 100, 'touch');
    assert(!tip(narrow).hidden && tip(narrow).textContent.includes('2012'), 'tap selects');
    narrow.focus(); assert(tip(narrow).textContent.includes('2012'), 'compatibility focus keeps tapped category');
    assert(getComputedStyle(tip(narrow)).position === 'relative', 'narrow values below plot');
    key(narrow, 'Escape');
    pointer(narrow, 'pointerdown', 245, 100, 'touch'); pointer(narrow, 'pointerup', 300, 150, 'touch');
    assert(tip(narrow).hidden, 'scroll gesture does not select');
    pie.focus(); key(pie, 'ArrowRight'); assert(tip(pie).textContent.includes('70'), 'pie keyboard');
    assert(pie.querySelector('[data-chart-index="1"]').classList.contains('is-inspected'), 'pie highlight');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); assert(tip(pie).hidden, 'outside dismissal');
    const dynamic = document.createElement('div');
    const hostile = '<img src=x onerror=alert(1)>';
    dynamic.innerHTML = renderChartArtifact({ spec: { chartType: 'line', title: 'Dense line',
        xLabels: Array.from({ length: 200 }, (_, i) => `Day ${i}`), series: [{ name: hostile, values: Array.from({ length: 200 }, (_, i) => i / 1000) }] } });
    fixture.append(dynamic);
    const dense = dynamic.querySelector('.oa-chart-plot'); dense.focus(); key(dense, 'End');
    assert(tip(dense).textContent.includes('0.199') && tip(dense).textContent.includes(hostile), 'dense exact value and literal hostile label');
    assert(!tip(dense).querySelector('img'), 'no HTML injection');
    assert(dense.querySelectorAll('.oa-chart-active-point').length === 1, 'dense active point without static markers');
    dynamic.remove();
    line.focus(); key(line, 'ArrowRight');
    line.closest('figure').style.width = '500px';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    assert(tip(line).hidden, 'resizing dismisses stale tooltip position');
    line.closest('figure').style.width = '';
    dispose(); line.blur(); line.focus(); assert(tip(line).hidden, 'dispose removes listeners');
    installChartInteractions(document);
    line.blur();
    document.querySelector('#results').textContent = `${checks} browser assertions passed`;
    document.title = 'Chart inspection PASS';
} catch (error) {
    document.querySelector('#results').textContent = error.stack;
    document.title = 'Chart inspection FAIL';
    throw error;
}
