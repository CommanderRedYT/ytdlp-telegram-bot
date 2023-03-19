/* eslint-disable max-len */
import * as fs from 'fs';

export default class ConfigManager {
    private _config: object;
    private _fsWatcher: fs.FSWatcher | null = null;
    private saveOnSet: boolean;
    private loadOnGet: boolean;
    private reloadOnDiskChange: boolean;
    private _configPath: string;
    private debug: boolean;

    constructor(configPath = 'config.json', saveOnSet = true, loadOnGet = true, reloadOnDiskChange = true, debug = false) {
        this.reconfigure(configPath, saveOnSet, loadOnGet, reloadOnDiskChange, debug);
        this.load();
    }

    reconfigure(configPath = 'config.json', saveOnSet = true, loadOnGet = true, reloadOnDiskChange = true, debug = false) {
        this._configPath = configPath;
        this.saveOnSet = saveOnSet;
        this.loadOnGet = loadOnGet;
        this.reloadOnDiskChange = reloadOnDiskChange;
        this.debug = debug;

        this.reconfigureOnDiskChange();
    }

    private reconfigureOnDiskChange() {
        if (this.reloadOnDiskChange) {
            this._fsWatcher = fs.watch(this._configPath, () => {
                if (this.debug)
                    console.log('Config file changed, reloading...');
                this.load();
            });
        } else if (this._fsWatcher) {
            this._fsWatcher.close();
            this._fsWatcher = null;
        }
    }

    get(key: string) {
        if (this.loadOnGet) {
            this.load();
        }
        return this._config[key];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    set(key: string, value: any) {
        this._config[key] = value;
        if (this.saveOnSet) {
            this.save();
        }
    }

    check(key: string) {
        return this._config[key] !== undefined;
    }

    checkIfConfigExists() {
        return fs.existsSync(this._configPath);
    }

    createIfNotExists() {
        if (!this.checkIfConfigExists()) {
            fs.writeFileSync(this._configPath, '{}');
        }
    }

    save() {
        this.createIfNotExists();
        fs.writeFileSync(this._configPath, JSON.stringify(this._config, null, 4));
    }

    load() {
        this.createIfNotExists();
        try {
            this._config = JSON.parse(fs.readFileSync(this._configPath, 'utf8'));
        } catch (e) {
            this._config = {};
            this.save();
        }
    }

    getConfigPath() {
        return this._configPath;
    }

    setDebug(debug: boolean) {
        this.debug = debug;
    }

    getAllKeys() {
        return Object.keys(this._config);
    }
}
