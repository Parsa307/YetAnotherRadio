import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

export const USER_AGENT = 'yetanotherradio-extension/1.0';
export const STORAGE_PATH = GLib.build_filenamev([
    GLib.get_user_state_dir(),
    'yetanotherradio',
    'stations.json',
]);

export function ensureStorageFile() {
    try {
        const dir = GLib.path_get_dirname(STORAGE_PATH);
        if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(dir, 0o755);
        }

        if (!GLib.file_test(STORAGE_PATH, GLib.FileTest.EXISTS)) {
            GLib.file_set_contents(STORAGE_PATH, '[]');
        }
    } catch (error) {
        console.error('Failed to ensure storage file exists', error);
        throw new Error('Could not create storage directory. Check file permissions.');
    }
}

export function loadStations() {
    try {
        ensureStorageFile();
    } catch (error) {
        console.error('Failed to ensure storage file', error);
        return [];
    }

    try {
        const [, contents] = GLib.file_get_contents(STORAGE_PATH);
        const text = new TextDecoder().decode(contents);
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .filter(station => typeof station === 'object' && station)
            .map(_sanitizeStation);
    } catch (error) {
        console.error('Failed to load stations', error);
        if (error.code === GLib.IOErrorEnum.NOT_FOUND) {
            console.warn('Stations file not found, returning empty list');
            return [];
        }
        return [];
    }
}

export function saveStations(stations) {
    try {
        ensureStorageFile();
    } catch (error) {
        console.error('Failed to ensure storage file', error);
        throw error;
    }

    try {
        const sanitized = stations
            .filter(station => station?.uuid && station?.url)
            .map(_sanitizeStation);
        const sorted = sanitized.sort((a, b) =>
            stationDisplayName(a).localeCompare(stationDisplayName(b), undefined, { sensitivity: 'base' }));
        const json = JSON.stringify(sorted, null, 2);
        GLib.file_set_contents(STORAGE_PATH, json);
        return sorted;
    } catch (error) {
        console.error('Failed to save stations', error);
        if (error.code === GLib.IOErrorEnum.PERMISSION_DENIED) {
            throw new Error('Permission denied. Cannot save stations file.');
        }
        throw new Error(`Failed to save stations: ${error.message || 'Unknown error'}`);
    }
}

export function stationDisplayName(station) {
    const base = station?.name?.trim() || station?.url || 'Unnamed station';
    const country = station?.countrycode ? ` (${station.countrycode})` : '';
    return `${base}${country}`;
}

export class RadioBrowserClient {
    constructor(settings = null) {
        const timeout = settings?.get_int('http-request-timeout') ?? 10;
        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: timeout,
        });
        this._servers = null;
        this._settings = settings;
        this._timeoutId = null;
    }

    async searchStations(query) {
        const trimmed = query?.trim();
        if (!trimmed)
            return [];

        await this._ensureServers();

        const shuffled = this._servers.slice().sort(() => Math.random() - 0.5);
        let lastError = null;
        const maxRetries = 3;

        const searchLimit = this._settings?.get_int('search-result-limit') ?? 25;
        for (const baseUrl of shuffled) {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const url = `${baseUrl}/json/stations/search?name=${encodeURIComponent(trimmed)}` +
                        `&limit=${searchLimit}&hidebroken=true`;
                    return await this._fetchJson(url);
                } catch (error) {
                    lastError = error;
                    if (attempt < maxRetries - 1) {
                        const delay = Math.pow(2, attempt) * 100;
                        if (this._timeoutId) {
                            GLib.source_remove(this._timeoutId);
                        }
                        await new Promise(resolve => {
                            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                                this._timeoutId = null;
                            resolve();
                            return false;
                            });
                        });
                    } else {
                        console.error(`Failed to query ${baseUrl} after ${maxRetries} attempts`, error);
                    }
                }
            }
        }

        if (lastError) {
            if (lastError.message && lastError.message.includes('timeout')) {
                throw new Error('Network request timed out. Please check your internet connection.');
            }
            throw new Error('All radio servers failed to respond. Please try again later.');
        }
        throw new Error('All radio servers failed to respond.');
    }

    async _ensureServers() {
        if (this._servers?.length)
            return;

        const payload = await this._fetchJson('http://all.api.radio-browser.info/json/servers');
        const hosts = payload
            .map(server => server?.name)
            .filter(Boolean)
            .map(name => `https://${name}`);

        if (!hosts.length)
            throw new Error('Radio Browser server list is empty.');

        this._servers = hosts;
    }

    async _fetchJson(url) {
        const message = Soup.Message.new('GET', url);

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        const data = session.send_and_read_finish(result);
                        resolve(data.toArray());
                    } catch (error) {
                        if (error.message && error.message.includes('timeout')) {
                            reject(new Error('Network request timed out. Please check your internet connection.'));
                        } else {
                            reject(error);
                        }
                    }
                }
            );
        });

        if (message.status_code < 200 || message.status_code >= 300) {
            if (message.status_code === 404) {
                throw new Error('Resource not found. The server may be unavailable.');
            } else if (message.status_code >= 500) {
                throw new Error('Server error. Please try again later.');
            } else {
                throw new Error(`Request failed with status ${message.status_code}`);
            }
        }

        try {
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (error) {
            throw new Error('Invalid response from server.');
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }
}

function _sanitizeStation(station) {
    return {
        uuid: station.uuid || station.stationuuid || '',
        name: station.name || '',
        url: station.url || station.url_resolved || '',
        homepage: station.homepage || '',
        favicon: station.favicon || '',
        countrycode: station.countrycode || '',
        favorite: station.favorite || false,
        lastPlayed: station.lastPlayed || null,
    };
}

