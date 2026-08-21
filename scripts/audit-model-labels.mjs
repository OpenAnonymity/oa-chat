import {
    getComposerModelDisplayName,
    getProviderlessModelDisplayName
} from '../chat/domain/modelSelection.js';

const modelsUrl = process.env.OPENROUTER_MODELS_URL || 'https://openrouter.ai/api/v1/models';

const response = await fetch(modelsUrl, {
    headers: {
        Accept: 'application/json'
    }
});

if (!response.ok) {
    throw new Error(`Failed to fetch model catalog: ${response.status} ${response.statusText}`);
}

const payload = await response.json();
if (!Array.isArray(payload?.data)) {
    throw new Error('Model catalog response did not include a data array.');
}

const models = payload.data;
if (models.length === 0) {
    throw new Error('Model catalog response contained no models.');
}

const namelessModels = models.filter((model) => !String(model?.name || model?.id || '').trim());
if (namelessModels.length > 0) {
    throw new Error(`${namelessModels.length} model catalog records had neither name nor id.`);
}

const failures = models
    .map((model) => {
        const name = String(model?.name || model?.id || '').trim();
        const composerName = getComposerModelDisplayName(name);
        return {
            id: model?.id || '',
            name,
            composerName
        };
    })
    .filter((entry) => entry.name && !entry.composerName);

if (failures.length === 0) {
    const longest = models
        .map((model) => {
            const name = String(model?.name || model?.id || '').trim();
            const composerName = getComposerModelDisplayName(name);
            return {
                id: model?.id || '',
                name,
                composerName,
                length: composerName.length
            };
        })
        .sort((a, b) => b.length - a.length)[0];

    console.log(`All ${models.length} model labels normalize to providerless composer labels.`);
    if (longest) {
        console.log(`Longest label is ${longest.length} chars and will be truncated by CSS if needed: ${longest.composerName} [${longest.id}]`);
    }
    process.exit(0);
}

console.error(`${failures.length} model labels normalized to an empty composer label:`);
for (const failure of failures) {
    console.error(`- ${getProviderlessModelDisplayName(failure.name)} <- ${failure.name} [${failure.id}]`);
}

process.exitCode = 1;
