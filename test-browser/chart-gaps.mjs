import { renderMessageCharts, chartCartesianLayout } from '../chat/components/chartSvg.js';
import { installChartInteractions } from '../chat/components/chartInteractions.js';
import { applyChartToolResult, getMessageCopyText } from '../chat/domain/chartArtifacts.js';

// Supplied synthetic values, not an actual Toronto forecast.
const spec = { chartType: 'line', title: 'Seven-day forecast — test data', yAxisTitle: '°C',
    xLabels: ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'], series: [
        { name: 'High', values: [9, 8, 5, 4, 3, 4, 5] },
        { name: 'Low', values: [3, 2, null, -1, -2, 0, null] }
    ] };
const message = { content: '' };
applyChartToolResult(message, [{ id: 'forecast', function: { name: 'render_chart', arguments: JSON.stringify(spec) } }]);
const fixture = document.querySelector('#fixture');
fixture.innerHTML = renderMessageCharts(message) + renderMessageCharts({ artifacts: [{ ...message.artifacts[0],
    spec: { ...spec, chartType: 'bar', title: 'Same data as bars' } }] });
installChartInteractions(document);
let checks = 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); checks++; };
const key = (plot, key) => plot.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
try {
    for (const plot of fixture.querySelectorAll('.oa-chart-plot')) {
        plot.focus(); key(plot, 'End');
        const tip = plot.querySelector('.oa-chart-tooltip');
        assert(tip.textContent.includes('Mon') && tip.textContent.includes('5') && tip.textContent.includes('Not available'), 'last day and known high must remain');
        if (plot.dataset.chartSpec.includes('"chartType":"line"')) {
            assert(plot.querySelectorAll('.oa-chart-active-point').length === 1, 'missing low must not create an active point');
            const lowPath = plot.querySelectorAll('.oa-chart-line')[1].getAttribute('d');
            assert((lowPath.match(/M/g) || []).length === 2, 'line must break across missing Thursday');
            assert(plot.querySelectorAll('.oa-chart-marker').length === 12, 'only the 12 actual values get markers');
        } else assert(plot.querySelectorAll('.oa-chart-bar').length === 12, 'missing values must not create bars');
        key(plot, 'ArrowLeft');
        assert(tip.textContent.includes('Sun') && tip.querySelectorAll('.oa-chart-tooltip-value')[1].textContent === '0', 'true zero must remain zero');
        key(plot, 'Escape');
        assert(tip.hidden, 'Escape dismisses');
    }
    assert(getMessageCopyText(message).includes('Mon\t5\tNot available'), 'Copy must preserve Monday and the gap');
    const saved = JSON.parse(JSON.stringify(message));
    assert(renderMessageCharts(saved).includes('Not available'), 'restored chart retains gaps');
    const layout = chartCartesianLayout({ ...spec, series: [{ name: 'Positive', values: [20, null, 22] }] });
    assert(layout.scaleY(0) > layout.plotBottom, 'a null must not pull the line axis to zero');
    document.querySelector('#results').textContent = `${checks} checks PASS`;
    document.title = 'Chart gaps PASS';
} catch (error) {
    document.querySelector('#results').textContent = error.stack;
    document.title = 'Chart gaps FAIL';
}
