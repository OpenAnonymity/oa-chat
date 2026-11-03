// Pure chart rendering: a validated chart spec in, an SVG + legend + data
// table string out. No DOM, no network, no library. Colors come from CSS
// custom properties (styles.css: --oa-chart-1..8, stepped per theme), so the
// chart follows the app's light/dark switch. Every string from the spec is
// escaped here; numbers are formatted here. Kept dependency-free so it can be
// audited in one read and swapped for a library later without touching the
// message templates.

import { validateChartSpec } from '../domain/chartArtifacts.js';

const WIDTH = 640;
const PLOT_HEIGHT = 300;
const MARGIN = Object.freeze({ top: 16, right: 16, bottom: 44, left: 56 });
const MAX_SERIES_COLORS = 8;
const MAX_MARKERS = 60;
const MAX_X_LABELS = 12;
const PIE_RADIUS = 110;

function escapeText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function round(value, places = 2) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

export function formatChartNumber(value) {
    if (!Number.isFinite(value)) return '';
    const magnitude = Math.abs(value);
    if (magnitude >= 1e9) return `${round(value / 1e9, 1)}B`;
    if (magnitude >= 1e6) return `${round(value / 1e6, 1)}M`;
    if (magnitude >= 1e4) return `${round(value / 1e3, 1)}k`;
    if (magnitude >= 100) return String(Math.round(value));
    if (magnitude >= 1) return String(round(value, 1));
    return String(round(value, 2));
}

function seriesColor(index) {
    return `var(--oa-chart-${(index % MAX_SERIES_COLORS) + 1})`;
}

/** Nice axis ticks covering [min, max]; always a handful, always round numbers. */
export function niceTicks(min, max, count = 5) {
    if (!(max > min)) {
        const base = Number.isFinite(min) ? min : 0;
        return base === 0 ? [0, 1] : [Math.min(0, base), Math.max(0, base)];
    }
    const span = max - min;
    const rough = span / Math.max(1, count - 1);
    const power = 10 ** Math.floor(Math.log10(rough));
    const candidates = [1, 2, 2.5, 5, 10].map(step => step * power);
    const step = candidates.find(candidate => span / candidate <= count) || candidates[candidates.length - 1];
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks = [];
    for (let tick = start; tick <= end + step / 2; tick += step) ticks.push(round(tick, 10));
    return ticks;
}

function valueRange(spec) {
    let min = Infinity;
    let max = -Infinity;
    for (const series of spec.series) {
        for (const value of series.values) {
            if (value < min) min = value;
            if (value > max) max = value;
        }
    }
    // Bars grow from zero; lines include zero when the data is near it.
    if (spec.chartType === 'bar' || (min > 0 && min < max * 0.4)) min = Math.min(0, min);
    if (max < 0 && spec.chartType === 'bar') max = 0;
    return { min, max };
}

function xLabelIndices(count) {
    if (count <= MAX_X_LABELS) return Array.from({ length: count }, (_, i) => i);
    const step = Math.ceil(count / MAX_X_LABELS);
    const indices = [];
    for (let i = 0; i < count; i += step) indices.push(i);
    // Always label the last point; drop a neighbour that would collide with it.
    const last = indices[indices.length - 1];
    if (last !== count - 1) {
        if (count - 1 - last < step / 2) indices.pop();
        indices.push(count - 1);
    }
    return indices;
}

function axes(spec, ticks, scaleY, plotLeft, plotRight, plotTop, plotBottom, bandX) {
    const grid = ticks.map(tick => {
        const y = scaleY(tick);
        return `<line class="oa-chart-grid" x1="${plotLeft}" x2="${plotRight}" y1="${y}" y2="${y}"/>` +
            `<text class="oa-chart-tick" x="${plotLeft - 8}" y="${y}" text-anchor="end" dominant-baseline="middle">${escapeText(formatChartNumber(tick))}</text>`;
    }).join('');
    const zero = ticks.includes(0) ? `<line class="oa-chart-baseline" x1="${plotLeft}" x2="${plotRight}" y1="${scaleY(0)}" y2="${scaleY(0)}"/>` : '';
    const labels = xLabelIndices(spec.xLabels.length).map(i =>
        `<text class="oa-chart-tick" x="${bandX(i)}" y="${plotBottom + 18}" text-anchor="middle">${escapeText(spec.xLabels[i])}</text>`
    ).join('');
    const xTitle = spec.xAxisTitle
        ? `<text class="oa-chart-axis-title" x="${(plotLeft + plotRight) / 2}" y="${plotBottom + 38}" text-anchor="middle">${escapeText(spec.xAxisTitle)}</text>`
        : '';
    const yTitle = spec.yAxisTitle
        ? `<text class="oa-chart-axis-title" transform="translate(12 ${(plotTop + plotBottom) / 2}) rotate(-90)" text-anchor="middle">${escapeText(spec.yAxisTitle)}</text>`
        : '';
    return grid + zero + labels + xTitle + yTitle;
}

function renderBars(spec) {
    const plotLeft = MARGIN.left;
    const plotRight = WIDTH - MARGIN.right;
    const plotTop = MARGIN.top;
    const plotBottom = PLOT_HEIGHT - MARGIN.bottom;
    const { min, max } = valueRange(spec);
    const ticks = niceTicks(min, max);
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const scaleY = value => plotBottom - ((value - lo) / (hi - lo || 1)) * (plotBottom - plotTop);
    const groups = spec.xLabels.length;
    const groupWidth = (plotRight - plotLeft) / groups;
    const seriesCount = spec.series.length;
    const gap = 2;
    const inner = groupWidth * 0.72;
    const barWidth = Math.max(1, (inner - gap * (seriesCount - 1)) / seriesCount);
    const bandX = i => plotLeft + groupWidth * (i + 0.5);
    const zeroY = scaleY(Math.max(lo, Math.min(hi, 0)));
    const radius = Math.min(4, barWidth / 2);
    const marks = spec.series.map((series, s) => series.values.map((value, i) => {
        const x = bandX(i) - inner / 2 + s * (barWidth + gap);
        const y = scaleY(value);
        const top = Math.min(y, zeroY);
        const height = Math.abs(zeroY - y);
        const title = `${series.name} · ${spec.xLabels[i]}: ${formatChartNumber(value)}`;
        // Rounded end on the data side only; the baseline side stays square.
        const r = Math.min(radius, height);
        const path = value >= 0
            ? `M${x} ${top + height} V${top + r} a${r} ${r} 0 0 1 ${r} -${r} h${barWidth - 2 * r} a${r} ${r} 0 0 1 ${r} ${r} V${top + height} Z`
            : `M${x} ${top} V${top + height - r} a${r} ${r} 0 0 0 ${r} ${r} h${barWidth - 2 * r} a${r} ${r} 0 0 0 ${r} -${r} V${top} Z`;
        return `<path class="oa-chart-bar" d="${path}" fill="${seriesColor(s)}"><title>${escapeText(title)}</title></path>`;
    }).join('')).join('');
    return `<svg class="oa-chart-svg" viewBox="0 0 ${WIDTH} ${PLOT_HEIGHT}" role="img" aria-label="${escapeText(spec.title)}">` +
        axes(spec, ticks, scaleY, plotLeft, plotRight, plotTop, plotBottom, bandX) + marks + '</svg>';
}

function renderLines(spec) {
    const plotLeft = MARGIN.left;
    const plotRight = WIDTH - MARGIN.right;
    const plotTop = MARGIN.top;
    const plotBottom = PLOT_HEIGHT - MARGIN.bottom;
    const { min, max } = valueRange(spec);
    const ticks = niceTicks(min, max);
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const scaleY = value => plotBottom - ((value - lo) / (hi - lo || 1)) * (plotBottom - plotTop);
    const points = spec.xLabels.length;
    const bandX = i => points === 1 ? (plotLeft + plotRight) / 2 : plotLeft + ((plotRight - plotLeft) * i) / (points - 1);
    const showMarkers = points <= MAX_MARKERS;
    const marks = spec.series.map((series, s) => {
        const d = series.values.map((value, i) => `${i === 0 ? 'M' : 'L'}${round(bandX(i), 1)} ${round(scaleY(value), 1)}`).join(' ');
        const line = `<path class="oa-chart-line" d="${d}" stroke="${seriesColor(s)}"><title>${escapeText(series.name)}</title></path>`;
        const markers = showMarkers ? series.values.map((value, i) =>
            `<circle class="oa-chart-marker" cx="${round(bandX(i), 1)}" cy="${round(scaleY(value), 1)}" r="3.5" fill="${seriesColor(s)}"><title>${escapeText(`${series.name} · ${spec.xLabels[i]}: ${formatChartNumber(value)}`)}</title></circle>`
        ).join('') : '';
        return line + markers;
    }).join('');
    return `<svg class="oa-chart-svg" viewBox="0 0 ${WIDTH} ${PLOT_HEIGHT}" role="img" aria-label="${escapeText(spec.title)}">` +
        axes(spec, ticks, scaleY, plotLeft, plotRight, plotTop, plotBottom, bandX) + marks + '</svg>';
}

function renderPie(spec) {
    const [series] = spec.series;
    const total = series.values.reduce((sum, value) => sum + value, 0);
    const cx = WIDTH / 2;
    const cy = PIE_RADIUS + 16;
    const height = cy + PIE_RADIUS + 16;
    if (!(total > 0)) {
        return `<svg class="oa-chart-svg" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeText(spec.title)}">` +
            `<text class="oa-chart-tick" x="${cx}" y="${cy}" text-anchor="middle">No non-zero values</text></svg>`;
    }
    let angle = -Math.PI / 2;
    const slices = series.values.map((value, i) => {
        if (value <= 0) return '';
        const share = value / total;
        const sweep = share * Math.PI * 2;
        const start = angle;
        const end = angle + sweep;
        angle = end;
        const large = sweep > Math.PI ? 1 : 0;
        const x1 = cx + PIE_RADIUS * Math.cos(start);
        const y1 = cy + PIE_RADIUS * Math.sin(start);
        const x2 = cx + PIE_RADIUS * Math.cos(end);
        const y2 = cy + PIE_RADIUS * Math.sin(end);
        const path = share >= 0.9999
            ? `M${cx - PIE_RADIUS} ${cy} a${PIE_RADIUS} ${PIE_RADIUS} 0 1 0 ${PIE_RADIUS * 2} 0 a${PIE_RADIUS} ${PIE_RADIUS} 0 1 0 -${PIE_RADIUS * 2} 0`
            : `M${cx} ${cy} L${round(x1, 2)} ${round(y1, 2)} A${PIE_RADIUS} ${PIE_RADIUS} 0 ${large} 1 ${round(x2, 2)} ${round(y2, 2)} Z`;
        const mid = start + sweep / 2;
        const labelRadius = PIE_RADIUS * 0.62;
        const label = share >= 0.06
            ? `<text class="oa-chart-slice-label" x="${round(cx + labelRadius * Math.cos(mid), 1)}" y="${round(cy + labelRadius * Math.sin(mid), 1)}" text-anchor="middle" dominant-baseline="middle">${Math.round(share * 100)}%</text>`
            : '';
        const title = `${spec.xLabels[i]}: ${formatChartNumber(value)} (${Math.round(share * 1000) / 10}%)`;
        return `<path class="oa-chart-slice" d="${path}" fill="${seriesColor(i)}"><title>${escapeText(title)}</title></path>${label}`;
    }).join('');
    return `<svg class="oa-chart-svg" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeText(spec.title)}">${slices}</svg>`;
}

function renderLegend(spec) {
    const entries = spec.chartType === 'pie'
        ? spec.xLabels.map((label, i) => ({ label, index: i }))
        : spec.series.map((series, i) => ({ label: series.name, index: i }));
    if (entries.length < 2) return '';
    return `<ul class="oa-chart-legend" aria-label="Legend">${entries.map(entry =>
        `<li><span class="oa-chart-swatch" style="background:${seriesColor(entry.index)}"></span>${escapeText(entry.label)}</li>`
    ).join('')}</ul>`;
}

function renderTable(spec) {
    const head = `<tr><th scope="col">${escapeText(spec.xAxisTitle || '')}</th>${spec.series.map(series => `<th scope="col">${escapeText(series.name)}</th>`).join('')}</tr>`;
    const rows = spec.xLabels.map((label, i) =>
        `<tr><th scope="row">${escapeText(label)}</th>${spec.series.map(series => `<td>${escapeText(formatChartNumber(series.values[i]))}</td>`).join('')}</tr>`
    ).join('');
    return `<details class="oa-chart-data"><summary>Show data</summary><div class="oa-chart-table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div></details>`;
}

/**
 * Renders a chart artifact as a self-contained card. Returns '' for anything
 * that does not validate, so a corrupted stored artifact renders nothing
 * rather than something half-right.
 */
export function renderChartArtifact(artifact, options = {}) {
    const { spec } = validateChartSpec(artifact?.spec);
    if (!spec) return '';
    const plot = spec.chartType === 'bar' ? renderBars(spec)
        : spec.chartType === 'line' ? renderLines(spec)
            : renderPie(spec);
    const messageId = typeof options.messageId === 'string' ? options.messageId : '';
    return `<figure class="oa-chart-card" data-chart-type="${spec.chartType}"${messageId ? ` data-chart-message-id="${escapeText(messageId)}"` : ''}>` +
        `<figcaption class="oa-chart-title">${escapeText(spec.title)}</figcaption>` +
        plot + renderLegend(spec) + renderTable(spec) + '</figure>';
}

/** The placeholder shown while a chart's data is still streaming. */
export function renderChartPlaceholder() {
    return '<figure class="oa-chart-card oa-chart-card-pending" aria-busy="true" aria-label="Preparing a chart">' +
        '<figcaption class="oa-chart-title">Preparing a chart…</figcaption>' +
        '<div class="oa-chart-skeleton"><span></span><span></span><span></span><span></span><span></span></div></figure>';
}
