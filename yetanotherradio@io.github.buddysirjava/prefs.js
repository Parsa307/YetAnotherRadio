import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { loadStations, saveStations, stationDisplayName, RadioBrowserClient } from './radioUtils.js';

const SavedStationsPage = GObject.registerClass(
    class SavedStationsPage extends Adw.PreferencesPage {
        _init(stations, refreshCallback) {
            super._init({
                title: _('Saved Stations'),
            });

            this._stations = stations;
            this._refreshCallback = refreshCallback;

            this._savedGroup = new Adw.PreferencesGroup({
                title: _('Saved stations'),
                description: _('These stations appear in the panel indicator menu.'),
            });
            this.add(this._savedGroup);
            this._savedRows = [];
            this._refreshSavedGroup();
        }

        setStations(stations) {
            this._stations = stations;
            this._refreshSavedGroup();
        }

        _refreshSavedGroup() {
            this._savedRows.forEach(row => this._savedGroup.remove(row));
            this._savedRows = [];

            if (!this._stations.length) {
                const row = new Adw.ActionRow({
                    title: _('No stations saved yet.'),
                    subtitle: _('Use the Add Stations tab to add some.'),
                });
                row.set_sensitive(false);
                this._savedGroup.add(row);
                this._savedRows.push(row);
                return;
            }

            this._stations.forEach((station, index) => {
                const row = new Adw.ActionRow({
                    title: stationDisplayName(station),
                    subtitle: station.url || '',
                });

                const buttonBox = new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                });

                const editButton = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    tooltip_text: _('Edit'),
                    has_frame: false,
                });
                editButton.connect('clicked', () => this._editStation(station));
                buttonBox.append(editButton);

                if (index > 0) {
                    const upButton = new Gtk.Button({
                        icon_name: 'go-up-symbolic',
                        tooltip_text: _('Move up'),
                        has_frame: false,
                    });
                    upButton.connect('clicked', () => this._moveStation(index, -1));
                    buttonBox.append(upButton);
                }

                if (index < this._stations.length - 1) {
                    const downButton = new Gtk.Button({
                        icon_name: 'go-down-symbolic',
                        tooltip_text: _('Move down'),
                        has_frame: false,
                    });
                    downButton.connect('clicked', () => this._moveStation(index, 1));
                    buttonBox.append(downButton);
                }

                const favoriteButton = new Gtk.Button({
                    icon_name: station.favorite ? 'starred-symbolic' : 'non-starred-symbolic',
                    tooltip_text: station.favorite ? _('Remove from favorites') : _('Add to favorites'),
                    has_frame: false,
                });
                favoriteButton.connect('clicked', () => this._toggleFavorite(station.uuid));
                buttonBox.append(favoriteButton);

                const removeButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: _('Remove'),
                    has_frame: false,
                });
                removeButton.connect('clicked', () => this._removeStation(station.uuid));
                buttonBox.append(removeButton);

                row.add_suffix(buttonBox);
                row.set_activatable(false);
                row.set_sensitive(true);

                this._savedGroup.add(row);
                this._savedRows.push(row);
            });
        }

        _removeStation(uuid) {
            const station = this._stations.find(s => s.uuid === uuid);
            if (!station)
                return;

            const dialog = new Adw.MessageDialog({
                heading: _('Remove Station?'),
                body: _('Are you sure you want to remove "%s"?').format(stationDisplayName(station)),
                close_response: 'cancel',
                modal: true,
            });

            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('remove', _('Remove'));
            dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);

            dialog.connect('response', (dialog, response) => {
                if (response === 'remove') {
                    this._stations = this._stations.filter(s => s.uuid !== uuid);
                    this._stations = saveStations(this._stations);
                    this._refreshSavedGroup();
                    if (this._refreshCallback) {
                        this._refreshCallback(this._stations);
                    }
                }
            });

            const window = this.get_root();
            if (window && window instanceof Gtk.Window) {
                dialog.set_transient_for(window);
            }
            dialog.present();
        }

        _editStation(station) {
            const dialog = new Adw.MessageDialog({
                heading: _('Edit Station'),
                body: _('Edit station details'),
                close_response: 'cancel',
                modal: true,
            });

            const nameEntry = new Gtk.Entry({
                text: station.name || '',
                placeholder_text: _('Station name'),
            });

            const urlEntry = new Gtk.Entry({
                text: station.url || '',
                placeholder_text: _('Stream URL'),
            });

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12,
                margin_top: 20,
                margin_bottom: 20,
            });
            box.append(nameEntry);
            box.append(urlEntry);

            dialog.set_extra_child(box);

            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('save', _('Save'));
            dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);

            dialog.connect('response', (dialog, response) => {
                if (response === 'save') {
                    const newName = nameEntry.text?.trim();
                    const newUrl = urlEntry.text?.trim();

                    if (!newName) {
                        return;
                    }

                    if (!newUrl) {
                        return;
                    }

                    if (!this._validateUrl(newUrl)) {
                        return;
                    }

                    station.name = newName;
                    station.url = newUrl;
                    this._stations = saveStations(this._stations);
                    this._refreshSavedGroup();
                    if (this._refreshCallback) {
                        this._refreshCallback(this._stations);
                    }
                }
            });

            const window = this.get_root();
            if (window && window instanceof Gtk.Window) {
                dialog.set_transient_for(window);
            }
            dialog.present();
        }

        _moveStation(index, direction) {
            if (index + direction < 0 || index + direction >= this._stations.length)
                return;

            const station = this._stations[index];
            this._stations.splice(index, 1);
            this._stations.splice(index + direction, 0, station);
            this._stations = saveStations(this._stations);
            this._refreshSavedGroup();
            if (this._refreshCallback) {
                this._refreshCallback(this._stations);
            }
        }

        _toggleFavorite(uuid) {
            const station = this._stations.find(s => s.uuid === uuid);
            if (station) {
                station.favorite = !station.favorite;
                this._stations = saveStations(this._stations);
                this._refreshSavedGroup();
                if (this._refreshCallback) {
                    this._refreshCallback(this._stations);
                }
            }
        }

        _validateUrl(url) {
            if (!url || typeof url !== 'string')
                return false;

            const urlPattern = /^(https?|icecast|shoutcast|mms|rtsp|rtmp):\/\/.+/i;
            return urlPattern.test(url.trim());
        }
    });

const AddStationsPage = GObject.registerClass(
    class AddStationsPage extends Adw.PreferencesPage {
        _init(stations, refreshCallback, settings) {
            super._init({
                title: _('Add Stations'),
            });

            this._client = new RadioBrowserClient(settings);
            this._settings = settings;
            this._stations = stations;
            this._refreshCallback = refreshCallback;
            this._searching = false;
            this._searchDebounceTimer = null;
            this._idleSourceId = null;

            this._searchGroup = new Adw.PreferencesGroup({
                title: _('Search stations'),
                description: _('Search the Radio Browser network and save stations.'),
            });
            this.add(this._searchGroup);

            this._searchRow = new Adw.EntryRow({
                title: _('Search query'),
            });

            this._searchRow.connect('entry-activated', () => {
                this._cancelSearchDebounce();
                this._performSearch();
            });

            this._idleSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                const entry = this._searchRow.get_editable();
                if (entry && entry instanceof Gtk.Entry) {
                    entry.connect('activate', () => {
                        this._cancelSearchDebounce();
                        this._performSearch();
                    });
                    entry.connect('changed', () => {
                        this._scheduleSearchDebounce();
                    });
                }
                this._idleSourceId = null;
                return false;
            });

            this._searchButton = new Gtk.Button({
                icon_name: 'system-search-symbolic',
                tooltip_text: _('Search'),
                has_frame: false,
            });
            this._searchButton.connect('clicked', () => this._performSearch());
            this._searchRow.add_suffix(this._searchButton);
            this._searchGroup.add(this._searchRow);

            this._statusRow = new Adw.ActionRow({
                title: _('Status'),
                subtitle: _('Enter a query to start searching.'),
            });
            this._statusRow.set_sensitive(false);
            this._searchGroup.add(this._statusRow);

            this._loadingSpinner = new Gtk.Spinner();
            this._loadingSpinner.set_size_request(16, 16);
            this._statusRow.add_suffix(this._loadingSpinner);
            this._loadingSpinner.set_visible(false);

            this._resultsGroup = new Adw.PreferencesGroup({
                title: _('Search results'),
            });
            this._resultsGroup.set_visible(false);
            this.add(this._resultsGroup);
            this._resultRows = [];

            this._manualGroup = new Adw.PreferencesGroup({
                title: _('Add station manually'),
                description: _('Enter a station name and URL to add it directly.'),
            });
            this._manualGroup.set_margin_top(24);
            this.add(this._manualGroup);

            this._manualNameRow = new Adw.EntryRow({
                title: _('Station name'),
            });
            this._manualGroup.add(this._manualNameRow);

            this._manualUrlRow = new Adw.EntryRow({
                title: _('Stream URL'),
            });
            this._manualGroup.add(this._manualUrlRow);

            this._manualAddButton = new Gtk.Button({
                label: _('Add Station'),
                css_classes: ['suggested-action'],
            });
            this._manualAddButton.connect('clicked', () => this._saveManualStation());

            const buttonBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                margin_top: 12,
                margin_bottom: 0,
            });
            buttonBox.append(this._manualAddButton);
            this._manualGroup.add(buttonBox);
        }

        setStations(stations) {
            this._stations = stations;
        }

        destroy() {
            this._cancelSearchDebounce();
            if (this._idleSourceId) {
                GLib.source_remove(this._idleSourceId);
                this._idleSourceId = null;
            }
            if (this._client) {
                this._client.destroy();
                this._client = null;
            }
            super.destroy();
        }

        _cancelSearchDebounce() {
            if (this._searchDebounceTimer) {
                GLib.source_remove(this._searchDebounceTimer);
                this._searchDebounceTimer = null;
            }
        }

        _scheduleSearchDebounce() {
            this._cancelSearchDebounce();
            this._searchDebounceTimer = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                500,
                () => {
                    const query = this._searchRow.text?.trim();
                    if (query) {
                        this._performSearch();
                    }
                    this._searchDebounceTimer = null;
                    return false;
                }
            );
        }

        _setStatus(text, showSpinner = false) {
            this._statusRow.subtitle = text;
            if (this._loadingSpinner) {
                if (showSpinner) {
                    this._loadingSpinner.start();
                    this._loadingSpinner.set_visible(true);
                } else {
                    this._loadingSpinner.stop();
                    this._loadingSpinner.set_visible(false);
                }
            }
        }

        async _performSearch() {
            if (this._searching)
                return;

            const query = this._searchRow.text?.trim();
            if (!query) {
                this._setStatus(_('Please enter a search term.'), false);
                return;
            }

            this._searching = true;
            this._searchButton.sensitive = false;
            this._setStatus(_('Searching...'), true);
            this._clearResultRows();
            this._resultsGroup.set_visible(true);

            try {
                const stations = await this._client.searchStations(query);
                if (!stations.length) {
                    this._setStatus(_('No stations found.'), false);
                    return;
                }

                this._populateResults(stations);
                this._setStatus(_('Select a station to save it.'), false);
            } catch (error) {
                console.error('Radio search failed', error);
                const errorMsg = error.message || _('Failed to fetch stations.');
                this._setStatus(_('Error: %s').format(errorMsg), false);
            } finally {
                this._searching = false;
                this._searchButton.sensitive = true;
            }
        }

        _populateResults(stations) {
            this._clearResultRows();

            const searchLimit = this._settings?.get_int('search-result-limit') ?? 25;
            stations.slice(0, searchLimit).forEach(station => {
                const row = new Adw.ActionRow({
                    title: stationDisplayName(station),
                    subtitle: station.url_resolved || station.url || station.homepage || '',
                    activatable: true,
                });

                row.connect('activated', () => this._saveStationFromResult(station));

                const saveButton = new Gtk.Button({
                    icon_name: 'list-add-symbolic',
                    tooltip_text: _('Add to saved stations'),
                    has_frame: false,
                });
                saveButton.connect('clicked', () => this._saveStationFromResult(station));
                row.add_suffix(saveButton);

                this._resultsGroup.add(row);
                this._resultRows.push(row);
            });

            if (!this._resultRows.length) {
                const emptyRow = new Adw.ActionRow({
                    title: _('No stations found.'),
                });
                emptyRow.set_sensitive(false);
                this._resultsGroup.add(emptyRow);
                this._resultRows.push(emptyRow);
            }
        }

        _clearResultRows() {
            this._resultRows.forEach(row => this._resultsGroup.remove(row));
            this._resultRows = [];
        }

        _saveStationFromResult(station) {
            const entry = {
                uuid: station.stationuuid,
                name: station.name,
                url: station.url_resolved || station.url,
                homepage: station.homepage,
                favicon: station.favicon,
                countrycode: station.countrycode,
            };

            if (!entry.url) {
                this._setStatus(_('Selected station does not have a stream URL.'), false);
                return;
            }

            if (this._stations.some(saved => saved.uuid === entry.uuid)) {
                this._setStatus(_('Station already saved.'), false);
                return;
            }

            this._stations.push(entry);
            this._stations = saveStations(this._stations);
            this._setStatus(_('Saved "%s".').format(entry.name || _('station')), false);
            if (this._refreshCallback) {
                this._refreshCallback(this._stations);
            }
        }

        _validateUrl(url) {
            if (!url || typeof url !== 'string')
                return false;

            const urlPattern = /^(https?|icecast|shoutcast|mms|rtsp|rtmp):\/\/.+/i;
            return urlPattern.test(url.trim());
        }

        _saveManualStation() {
            const name = this._manualNameRow.text?.trim();
            const url = this._manualUrlRow.text?.trim();

            if (!name) {
                this._setStatus(_('Please enter a station name.'), false);
                return;
            }

            if (!url) {
                this._setStatus(_('Please enter a stream URL.'), false);
                return;
            }

            if (!this._validateUrl(url)) {
                this._setStatus(_('Please enter a valid URL.'), false);
                return;
            }

            const entry = {
                uuid: `manual-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                name: name,
                url: url,
                homepage: '',
                favicon: '',
                countrycode: '',
            };

            if (this._stations.some(saved => saved.url === entry.url)) {
                this._setStatus(_('A station with this URL is already saved.'), false);
                return;
            }

            try {
                this._stations.push(entry);
                this._stations = saveStations(this._stations);
                this._manualNameRow.text = '';
                this._manualUrlRow.text = '';
                this._setStatus(_('Saved "%s".').format(entry.name), false);
                if (this._refreshCallback) {
                    this._refreshCallback(this._stations);
                }
            } catch (error) {
                console.error('Failed to save manual station', error);
                const errorMsg = error.message || _('Failed to save station.');
                this._setStatus(_('Error: %s').format(errorMsg), false);
            }
        }
    });

const ImportExportPage = GObject.registerClass(
    class ImportExportPage extends Adw.PreferencesPage {
        _init(stations, refreshCallback) {
            super._init({
                title: _('Import / Export'),
            });

            this._stations = stations;
            this._refreshCallback = refreshCallback;

            this._importExportGroup = new Adw.PreferencesGroup({
                title: _('Import / Export'),
                description: _('Backup or restore your station list.'),
            });
            this.add(this._importExportGroup);

            this._exportRow = new Adw.ActionRow({
                title: _('Export Stations'),
                subtitle: _('Export your saved stations to a file.'),
            });
            this._exportRow.set_activatable(false);
            this._exportRow.set_sensitive(true);

            const exportButton = new Gtk.Button({
                icon_name: 'document-save-symbolic',
                tooltip_text: _('Export Stations'),
                has_frame: false,
            });
            exportButton.connect('clicked', () => this._exportStations());
            this._exportRow.add_suffix(exportButton);
            this._importExportGroup.add(this._exportRow);

            this._importRow = new Adw.ActionRow({
                title: _('Import Stations'),
                subtitle: _('Import stations from a backup file.'),
            });
            this._importRow.set_activatable(false);
            this._importRow.set_sensitive(true);

            const importButton = new Gtk.Button({
                icon_name: 'document-open-symbolic',
                tooltip_text: _('Import Stations'),
                has_frame: false,
            });
            importButton.connect('clicked', () => this._importStations());
            this._importRow.add_suffix(importButton);
            this._importExportGroup.add(this._importRow);
        }

        setStations(stations) {
            this._stations = stations;
        }

        _setExportStatus(text) {
            this._exportRow.subtitle = text;
        }

        _setImportStatus(text) {
            this._importRow.subtitle = text;
        }

        _exportStations() {
            try {
                const json = JSON.stringify(this._stations, null, 2);
                const jsonBytes = new TextEncoder().encode(json);
                const fileChooser = new Gtk.FileChooserNative({
                    title: _('Export Stations'),
                    action: Gtk.FileChooserAction.SAVE,
                    accept_label: _('Save'),
                });

                fileChooser.set_current_name('radio-stations.json');
                fileChooser.connect('response', (dialog, response) => {
                    if (response === Gtk.ResponseType.ACCEPT) {
                        const file = fileChooser.get_file();
                        if (file) {
                            try {
                                file.replace_contents(
                                    jsonBytes,
                                    null,
                                    false,
                                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                                    null
                                );
                                this._setExportStatus(_('Stations exported successfully.'));
                            } catch (error) {
                                console.error('Export failed', error);
                                this._setExportStatus(_('Failed to export stations.'));
                            }
                        }
                    }
                });

                const window = this.get_root();
                if (window && window instanceof Gtk.Window) {
                    fileChooser.set_transient_for(window);
                }
                fileChooser.show();
            } catch (error) {
                console.error('Export failed', error);
                this._setExportStatus(_('Failed to export stations.'));
            }
        }

        _importStations() {
            const fileChooser = new Gtk.FileChooserNative({
                title: _('Import Stations'),
                action: Gtk.FileChooserAction.OPEN,
                accept_label: _('Import'),
            });

            fileChooser.connect('response', (dialog, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = fileChooser.get_file();
                    if (file) {
                        try {
                            const [, contents] = file.load_contents(null);
                            const text = new TextDecoder().decode(contents);
                            const imported = JSON.parse(text);

                            if (!Array.isArray(imported)) {
                                this._setImportStatus(_('Invalid file format.'));
                                return;
                            }

                            const existingUuids = new Set(this._stations.map(s => s.uuid));
                            const newStations = imported.filter(s => !existingUuids.has(s.uuid));

                            this._stations = [...this._stations, ...newStations];
                            this._stations = saveStations(this._stations);
                            this._setImportStatus(_('Imported %d station(s).').format(newStations.length));
                            if (this._refreshCallback) {
                                this._refreshCallback(this._stations);
                            }
                        } catch (error) {
                            console.error('Import failed', error);
                            this._setImportStatus(_('Failed to import stations. Invalid file format.'));
                        }
                    }
                }
            });

            const window = this.get_root();
            if (window && window instanceof Gtk.Window) {
                fileChooser.set_transient_for(window);
            }
            fileChooser.show();
        }
    });

export default class YetAnotherRadioPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 640);

        const settings = this.getSettings();
        const stations = loadStations();

        const viewStack = new Adw.ViewStack();

        const refreshCallback = (newStations) => {
            savedStationsPage.setStations(newStations);
            addStationsPage.setStations(newStations);
            importExportPage.setStations(newStations);
        };

        const savedStationsPage = new SavedStationsPage(stations, refreshCallback);
        const addStationsPage = new AddStationsPage(stations, refreshCallback, settings);
        const importExportPage = new ImportExportPage(stations, refreshCallback);

        viewStack.add_titled(savedStationsPage, 'saved', _('Saved Stations'));
        viewStack.add_titled(addStationsPage, 'add', _('Add Stations'));
        viewStack.add_titled(importExportPage, 'import', _('Import / Export'));

        const tabBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 0,
            css_classes: ['linked'],
        });

        const savedButton = new Gtk.ToggleButton({
            label: _('Saved Stations'),
            active: true,
        });
        const addButton = new Gtk.ToggleButton({
            label: _('Add Stations'),
        });
        const importButton = new Gtk.ToggleButton({
            label: _('Import / Export'),
        });

        savedButton.connect('toggled', (btn) => {
            if (btn.active) {
                viewStack.set_visible_child_name('saved');
                addButton.set_active(false);
                importButton.set_active(false);
            }
        });
        tabBox.append(savedButton);

        addButton.connect('toggled', (btn) => {
            if (btn.active) {
                viewStack.set_visible_child_name('add');
                savedButton.set_active(false);
                importButton.set_active(false);
            }
        });
        tabBox.append(addButton);

        importButton.connect('toggled', (btn) => {
            if (btn.active) {
                viewStack.set_visible_child_name('import');
                savedButton.set_active(false);
                addButton.set_active(false);
            }
        });
        tabBox.append(importButton);

        const toolbarView = new Adw.ToolbarView();

        const headerBar = new Adw.HeaderBar();
        headerBar.set_title_widget(tabBox);
        toolbarView.add_top_bar(headerBar);

        toolbarView.set_content(viewStack);

        window.set_content(toolbarView);

        window.connect('close-request', () => {
            addStationsPage.destroy();
            return false;
        });
    }
}

