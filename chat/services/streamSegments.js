/**
 * Stream segments.
 *
 * A model that uses tools interleaves its streams: think, answer a line,
 * call a tool, think again, answer the rest. Each resumed segment starts
 * on its own paragraph, so a heading that follows a sentence is still a
 * heading and two separate thoughts do not run together as one.
 */

/**
 * @param {string} chunk - the first delta of a resumed segment
 * @param {string} accumulated - what that stream already holds
 * @returns {string} the chunk, with a blank line in front when needed
 */
export function paragraphBreakBefore(chunk, accumulated) {
    return accumulated && !/\n\s*$/.test(accumulated) ? `\n\n${chunk}` : chunk;
}

/**
 * Grok answers in segments around its own searches and may think again after
 * any line, so its header keeps saying "Thinking..." until the reply is
 * complete; only then does it read "Thought for Ns".
 * @param {string} modelId - the requested or reported model id
 * @returns {boolean}
 */
export function holdsThinkingThroughAnswer(modelId) {
    return /^x-ai\//i.test(String(modelId || ''));
}
