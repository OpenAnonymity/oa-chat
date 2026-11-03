import { validateChartSpec } from '../domain/chartArtifacts.js';
import { chartCartesianLayout } from './chartSvg.js';

const installations = new WeakMap();
const SVG_NS = 'http://www.w3.org/2000/svg';
const color = index => `var(--oa-chart-${index % 8 + 1})`;

export function chartIndexAtX(spec, x) {
    const { plotLeft, plotRight } = chartCartesianLayout(spec);
    const fraction = (x - plotLeft) / (plotRight - plotLeft);
    const count = spec.xLabels.length;
    return Math.max(0, Math.min(count - 1, spec.chartType === 'bar'
        ? Math.floor(fraction * count) : Math.round(fraction * (count - 1))));
}

// One delegated installation also covers restored messages, Parallel lanes,
// streamed replacements and the detached Quick Ask panel. No network/storage.
export function installChartInteractions(root) {
    if (installations.has(root)) return installations.get(root);
    const states = new WeakMap();
    const doc = root.ownerDocument || root;
    let active = null;
    let pointerStart = null;
    let activeWidth = 0;
    const ResizeObserver = doc.defaultView?.ResizeObserver;
    const resizeObserver = ResizeObserver ? new ResizeObserver(() => {
        if (active && Math.abs(active.clientWidth - activeWidth) > 0.5) hide(active);
    }) : null;
    const listeners = [];
    const on = (type, handler, options) => {
        root.addEventListener(type, handler, options);
        listeners.push([type, handler, options]);
    };
    const plotFor = event => event.target?.closest?.('.oa-chart-plot') || null;
    const stateFor = plot => {
        if (states.has(plot)) return states.get(plot);
        try {
            const { spec } = validateChartSpec(JSON.parse(plot.dataset.chartSpec));
            if (!spec) return null;
            const state = { spec, index: -1, dismissed: false };
            states.set(plot, state);
            return state;
        } catch { return null; }
    };
    const hide = plot => {
        if (!plot) return;
        resizeObserver?.unobserve(plot);
        const tooltip = plot.querySelector('.oa-chart-tooltip');
        if (tooltip) tooltip.hidden = true;
        plot.querySelector('.oa-chart-inspection')?.replaceChildren();
        plot.querySelectorAll('.oa-chart-slice.is-inspected').forEach(slice => slice.classList.remove('is-inspected'));
        if (active === plot) active = null;
    };
    const element = (tag, className, text) => {
        const node = doc.createElement(tag);
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const svgElement = (tag, attributes) => {
        const node = doc.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        return node;
    };
    const show = (plot, index) => {
        const state = stateFor(plot);
        if (!state) return;
        const { spec } = state;
        index = Math.max(0, Math.min(spec.xLabels.length - 1, index));
        const tooltip = plot.querySelector('.oa-chart-tooltip');
        const svg = plot.querySelector('svg');
        if (!tooltip || !svg) return;
        if (active && active !== plot) hide(active);
        const changed = state.index !== index || tooltip.hidden;
        state.index = index;
        state.dismissed = false;
        if (active !== plot) {
            activeWidth = plot.clientWidth;
            resizeObserver?.observe(plot);
        }
        active = plot;
        if (!changed) return;
        const title = element('div', 'oa-chart-tooltip-title', spec.xLabels[index]);
        const rows = spec.series.map((series, s) => {
            const row = element('div', 'oa-chart-tooltip-row');
            const swatch = element('span', 'oa-chart-tooltip-swatch');
            swatch.style.background = color(spec.chartType === 'pie' ? index : s);
            swatch.setAttribute('aria-hidden', 'true');
            row.append(swatch, element('span', 'oa-chart-tooltip-value', String(series.values[index])),
                element('span', 'oa-chart-tooltip-name', series.name));
            return row;
        });
        tooltip.replaceChildren(title, ...rows);
        if (spec.yAxisTitle) tooltip.append(element('div', 'oa-chart-tooltip-unit', spec.yAxisTitle));
        tooltip.hidden = false;
        let anchorX = 320;
        const overlay = plot.querySelector('.oa-chart-inspection');
        if (spec.chartType !== 'pie' && overlay) {
            const { plotLeft, plotRight, plotTop, plotBottom, scaleY } = chartCartesianLayout(spec);
            const count = spec.xLabels.length;
            anchorX = spec.chartType === 'bar' ? plotLeft + (plotRight - plotLeft) * (index + 0.5) / count
                : count === 1 ? (plotLeft + plotRight) / 2 : plotLeft + (plotRight - plotLeft) * index / (count - 1);
            overlay.replaceChildren(svgElement('line', { x1: anchorX, x2: anchorX, y1: plotTop, y2: plotBottom,
                class: 'oa-chart-guide' }));
            if (spec.chartType === 'line') spec.series.forEach((series, s) => {
                overlay.append(svgElement('circle', { cx: anchorX, cy: scaleY(series.values[index]), r: 4.5,
                    fill: color(s), class: 'oa-chart-active-point' }));
            });
        } else {
            plot.querySelectorAll('.oa-chart-slice').forEach(slice => {
                slice.classList.toggle('is-inspected', Number(slice.dataset.chartIndex) === index);
            });
        }
        const width = plot.clientWidth;
        const anchor = anchorX / 640 * width;
        const left = anchor + 14 + tooltip.offsetWidth <= width ? anchor + 14 : anchor - tooltip.offsetWidth - 14;
        tooltip.style.left = `${Math.max(0, Math.min(width - tooltip.offsetWidth, left))}px`;
        tooltip.style.top = '12px';
    };
    const inspectPointer = (plot, event) => {
        const state = stateFor(plot);
        if (!state) return;
        if (event.target.closest('.oa-chart-tooltip')) return;
        if (state.spec.chartType === 'pie') {
            const slice = event.target.closest('[data-chart-index]');
            if (slice) show(plot, Number(slice.dataset.chartIndex));
            return;
        }
        const svg = plot.querySelector('svg');
        // Transform into SVG units, including responsive scaling/letterboxing.
        const matrix = svg?.getScreenCTM();
        if (!matrix) return;
        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const local = point.matrixTransform(matrix.inverse());
        const { plotLeft, plotRight, plotTop, plotBottom } = chartCartesianLayout(state.spec);
        if (local.x < plotLeft || local.x > plotRight || local.y < plotTop || local.y > plotBottom) return;
        show(plot, chartIndexAtX(state.spec, local.x));
    };
    on('pointermove', event => {
        if (event.pointerType === 'touch') return;
        const plot = plotFor(event);
        if (plot && !stateFor(plot)?.dismissed) inspectPointer(plot, event);
    });
    on('pointerout', event => {
        const plot = plotFor(event);
        if (!plot || plot.contains(event.relatedTarget)) return;
        const state = stateFor(plot);
        if (state) state.dismissed = false;
        if (event.pointerType !== 'touch' && doc.activeElement !== plot) hide(plot);
    });
    on('pointerdown', event => {
        const plot = plotFor(event);
        if (active && active !== plot) hide(active);
        pointerStart = plot ? { plot, x: event.clientX, y: event.clientY, id: event.pointerId } : null;
    });
    on('pointerup', event => {
        const start = pointerStart;
        pointerStart = null;
        if (!start || start.id !== event.pointerId || start.plot !== plotFor(event)) return;
        // Let normal page scrolling win; only a tap selects a point on touch.
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 10) inspectPointer(start.plot, event);
    });
    on('pointercancel', () => { pointerStart = null; });
    on('focusin', event => {
        const plot = plotFor(event);
        // Touch compatibility focus can arrive after pointerup: keep the tapped category.
        if (event.target === plot && pointerStart?.plot !== plot) show(plot, Math.max(0, stateFor(plot)?.index ?? 0));
    });
    on('focusout', event => {
        const plot = plotFor(event);
        if (plot && !plot.contains(event.relatedTarget)) hide(plot);
    });
    on('keydown', event => {
        if (event.key === 'Escape' && active) {
            const state = stateFor(active);
            if (state) state.dismissed = true;
            hide(active);
            return;
        }
        const plot = plotFor(event);
        if (!plot || event.target !== plot) return;
        const state = stateFor(plot);
        if (!state || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        let index = Math.max(0, state.index);
        if (event.key === 'ArrowLeft') index--;
        if (event.key === 'ArrowRight') index++;
        if (event.key === 'Home') index = 0;
        if (event.key === 'End') index = state.spec.xLabels.length - 1;
        show(plot, index);
    });
    // A detached active chart must not remain strongly held between chats.
    const Observer = doc.defaultView?.MutationObserver;
    const observer = Observer ? new Observer(() => {
        if (active && !active.isConnected) { hide(active); pointerStart = null; }
    }) : null;
    observer?.observe(root, { childList: true, subtree: true });
    const dispose = () => {
        hide(active);
        observer?.disconnect();
        resizeObserver?.disconnect();
        listeners.forEach(([type, handler, options]) => root.removeEventListener(type, handler, options));
        installations.delete(root);
    };
    installations.set(root, dispose);
    return dispose;
}
