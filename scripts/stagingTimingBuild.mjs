// Replace the experiment module at build time when it is not explicitly selected.
// No recorder, storage key or upload path exists in ordinary/production artifacts.
export function stagingTimingPlugin(enabled) {
    return { name: 'exclude-staging-request-timing', setup(build) {
        if (enabled) return;
        build.onLoad({ filter: /[\\/]services[\\/]stagingRequestTiming\.js$/ }, () => ({ loader: 'js', contents: `
            export const startRequestTiming = () => {};
            export const finishRequestTiming = () => {};
            export const requestTiming = () => null;
            export const hasRequestTiming = () => false;
            export const timingTextVisible = () => false;
            export const setStagingTimingSink = () => {};
            export const timingCallbacks = (_timing, onChunk, onOpen, onReasoning) => ({onChunk,onOpen,onReasoning});
        ` }));
    } };
}
