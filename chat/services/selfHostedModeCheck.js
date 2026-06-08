const SELF_HOSTED_STATION_MODE_STORAGE_KEY = 'oa-self-hosted-station-enabled';

export function isSelfHostedStationModeEnabled() {
    if (typeof localStorage === 'undefined') return false;
    try {
        return localStorage.getItem(SELF_HOSTED_STATION_MODE_STORAGE_KEY) === 'true';
    } catch (error) {
        return false;
    }
}
