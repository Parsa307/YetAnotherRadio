import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Gst from 'gi://Gst';
import GLib from 'gi://GLib';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ExtensionUtils from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import { ensureStorageFile, loadStations, saveStations, stationDisplayName, STORAGE_PATH } from './radioUtils.js';

const METADATA_ICON_SIZE = 64;

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init(stations, openPrefs, extensionPath, settings) {
            super._init(0.0, _('Yet Another Radio'));

            this._stations = stations ?? [];
            this._openPrefs = openPrefs;
            this._settings = settings;
            this._player = null;
            this._nowPlaying = null;
            this._playbackState = 'stopped';
            this._metadataTimer = null;
            this._currentMetadata = {
                title: null,
                artist: null,
                albumArt: null
            };
            this._bus = null;
            this._busHandlerId = null;

            const iconPath = `${extensionPath}/icons/yetanotherradio.svg`;
            const iconFile = Gio.File.new_for_path(iconPath);
            const icon = new Gio.FileIcon({ file: iconFile });

            this.add_child(new St.Icon({
                gicon: icon,
                style_class: 'system-status-icon',
            }));

            this.menu.actor.add_style_class_name('yetanotherradio-menu');

            this._metadataItem = this._createMetadataItem();
            this._metadataItem.visible = false;
            this.menu.addMenuItem(this._metadataItem);

            this._playbackControlItem = new PopupMenu.PopupMenuItem(_('Pause'));
            this._playbackControlItem.connect('activate', () => this._togglePlayback());
            this._playbackControlItem.visible = false;
            this.menu.addMenuItem(this._playbackControlItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._favoritesSection = new PopupMenu.PopupMenuSection();
            this._favoritesSection.visible = false;
            this.menu.addMenuItem(this._favoritesSection);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._stationSection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._stationSection);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._prefsItem = new PopupMenu.PopupMenuItem(_('Open preferences'));
            this._prefsItem.connect('activate', () => this._openPrefs?.());
            this.menu.addMenuItem(this._prefsItem);

            this._hintItem = new PopupMenu.PopupMenuItem(_('Use preferences to add stations.'));
            this._hintItem.reactive = false;
            this._hintItem.sensitive = false;
            this.menu.addMenuItem(this._hintItem);

            this._refreshStationsMenu();
        }

        _createMetadataItem() {
            const box = new St.BoxLayout({
                vertical: false,
                style_class: 'metadata-item-box'
            });

            const thumbnail = new St.Icon({
                icon_name: 'audio-x-generic-symbolic',
                icon_size: METADATA_ICON_SIZE,
                style_class: 'metadata-thumbnail'
            });
            box.add_child(thumbnail);

            const textBox = new St.BoxLayout({
                vertical: true,
                style_class: 'metadata-text-box'
            });

            const titleLabel = new St.Label({
                text: '',
                style_class: 'metadata-title'
            });
            titleLabel.clutter_text.ellipsize = 3;
            textBox.add_child(titleLabel);

            const artistLabel = new St.Label({
                text: '',
                style_class: 'metadata-artist'
            });
            artistLabel.clutter_text.ellipsize = 3;
            textBox.add_child(artistLabel);

            const qualityLabel = new St.Label({
                text: '',
                style_class: 'metadata-quality'
            });
            textBox.add_child(qualityLabel);

            box.add_child(textBox);

            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            item.add_child(box);

            item._thumbnail = thumbnail;
            item._titleLabel = titleLabel;
            item._artistLabel = artistLabel;
            item._qualityLabel = qualityLabel;

            return item;
        }

        _updateMetadataDisplay() {
            const showMetadata = this._settings?.get_boolean('show-metadata') ?? true;
            if (!showMetadata || !this._metadataItem.visible || !this._player)
                return;

            this._queryPlayerTags();

            let title = this._currentMetadata.title || _('Unknown title');
            let artist = this._currentMetadata.artist || _('Unknown artist');
            const bitrate = this._currentMetadata.bitrate;

            if (title.length > 35) {
                title = title.substring(0, 32) + '...';
            }
            if (artist.length > 35) {
                artist = artist.substring(0, 32) + '...';
            }

            this._metadataItem._titleLabel.text = title;
            this._metadataItem._artistLabel.text = artist;

            if (bitrate) {
                const kbps = Math.round(bitrate / 1000);
                this._metadataItem._qualityLabel.text = `${kbps} kbps`;
                this._metadataItem._qualityLabel.visible = true;
            } else {
                this._metadataItem._qualityLabel.text = '';
                this._metadataItem._qualityLabel.visible = false;
            }

            let thumbnailSet = false;
            if (this._currentMetadata.albumArt) {
                try {
                    let file;
                    if (this._currentMetadata.albumArt.startsWith('file://') ||
                        this._currentMetadata.albumArt.startsWith('http://') ||
                        this._currentMetadata.albumArt.startsWith('https://')) {
                        file = Gio.File.new_for_uri(this._currentMetadata.albumArt);
                    } else if (this._currentMetadata.albumArt.startsWith('/')) {
                        file = Gio.File.new_for_path(this._currentMetadata.albumArt);
                    } else {
                        file = Gio.File.new_for_uri(this._currentMetadata.albumArt);
                    }
                    const icon = new Gio.FileIcon({ file: file });
                    this._metadataItem._thumbnail.gicon = icon;
                    this._metadataItem._thumbnail.icon_size = METADATA_ICON_SIZE;
                    thumbnailSet = true;
                } catch (e) {
                }
            }

            if (!thumbnailSet && this._nowPlaying?.favicon) {
                try {
                    const file = Gio.File.new_for_uri(this._nowPlaying.favicon);
                    const icon = new Gio.FileIcon({ file: file });
                    this._metadataItem._thumbnail.gicon = icon;
                    this._metadataItem._thumbnail.icon_size = METADATA_ICON_SIZE;
                    thumbnailSet = true;
                } catch (e) {
                }
            }

            if (!thumbnailSet) {
                this._metadataItem._thumbnail.icon_name = 'audio-x-generic-symbolic';
            }
        }

        _parseMetadataTags(tagList) {
            if (!tagList)
                return null;

            let title = null;
            if (tagList.get_string(Gst.TAG_TITLE)) {
                [, title] = tagList.get_string(Gst.TAG_TITLE);
            }

            let artist = null;
            if (tagList.get_string(Gst.TAG_ARTIST)) {
                [, artist] = tagList.get_string(Gst.TAG_ARTIST);
            }

            let albumArt = null;
            if (tagList.get_string(Gst.TAG_IMAGE)) {
                [, albumArt] = tagList.get_string(Gst.TAG_IMAGE);
            } else if (tagList.get_string(Gst.TAG_PREVIEW_IMAGE)) {
                [, albumArt] = tagList.get_string(Gst.TAG_PREVIEW_IMAGE);
            }

            return { title, artist, albumArt };
        }

        _queryPlayerTags() {
            if (!this._player)
                return;

            try {
                const tagList = this._player.query_tags(Gst.TagMergeMode.UNDEFINED);
                const metadata = this._parseMetadataTags(tagList);
                if (metadata) {
                    if (metadata.title) this._currentMetadata.title = metadata.title;
                    if (metadata.artist) this._currentMetadata.artist = metadata.artist;
                    if (metadata.albumArt) this._currentMetadata.albumArt = metadata.albumArt;
                    if (metadata.bitrate) this._currentMetadata.bitrate = metadata.bitrate;
                }
            } catch (e) {
            }
        }

        _loadStationIcon(item, faviconUrl) {
            if (!faviconUrl)
                return;

            try {
                const file = Gio.File.new_for_uri(faviconUrl);
                const icon = new Gio.FileIcon({ file: file });
                const iconWidget = new St.Icon({
                    gicon: icon,
                    icon_size: 16,
                    style_class: 'system-status-icon'
                });
                item.insert_child_at_index(iconWidget, 0);
            } catch (e) {
            }
        }

        setStations(stations) {
            this._stations = stations ?? [];
            this._refreshStationsMenu();
        }

        _refreshStationsMenu() {
            this._favoritesSection.removeAll();
            this._stationSection.removeAll();

            if (!this._stations.length) {
                const emptyItem = new PopupMenu.PopupMenuItem(_('No saved stations yet. Use preferences to add some.'));
                emptyItem.reactive = false;
                emptyItem.sensitive = false;
                this._stationSection.addMenuItem(emptyItem);
                this._hintItem.visible = true;
                return;
            }

            this._hintItem.visible = false;

            const favorites = this._stations.filter(s => s.favorite).sort((a, b) =>
                stationDisplayName(a).localeCompare(stationDisplayName(b))
            );
            const regular = this._stations.filter(s => !s.favorite);

            if (favorites.length > 0) {
                favorites.forEach(station => {
                    const item = this._createStationMenuItem(station);
                    this._favoritesSection.addMenuItem(item);
                });
                this._favoritesSection.visible = true;
            } else {
                this._favoritesSection.visible = false;
            }

            regular.forEach(station => {
                const item = this._createStationMenuItem(station);
                this._stationSection.addMenuItem(item);
            });
        }

        _createStationMenuItem(station) {
            const stationName = stationDisplayName(station);
            const item = new PopupMenu.PopupMenuItem(stationName);
            item.connect('activate', () => {
                this._playStation(station);
            });

            if (stationName.length > 40) {
                item.label.text = stationName.substring(0, 37) + '...';
            }

            if (station.favicon) {
                this._loadStationIcon(item, station.favicon);
            }

            return item;
        }

        _ensurePlayer() {
            if (!Indicator._gstInitialized) {
                try {
                    Gst.init(null);
                } catch (e) {
                }
                Indicator._gstInitialized = true;
            }

            if (this._player)
                return;

            this._player = Gst.ElementFactory.make('playbin', 'radio-player');

            const fakeVideoSink = Gst.ElementFactory.make('fakesink', 'fake-video-sink');
            this._player.set_property('video-sink', fakeVideoSink);

            this._bus = this._player.get_bus();
            this._bus.add_signal_watch();
            this._busHandlerId = this._bus.connect('message', (bus, message) => {
                if (message.type === Gst.MessageType.TAG) {
                    this._handleTagMessage(message);
                } else if (message.type === Gst.MessageType.ERROR) {
                    const [error, debug] = message.parse_error();
                    logError(error, debug);
                    let errorBody = _('Could not play the selected station.');
                    if (error) {
                        if (error.message && typeof error.message === 'string') {
                            errorBody = String(error.message);
                        } else if (debug && typeof debug === 'string') {
                            errorBody = String(debug);
                        } else if (typeof error === 'string') {
                            errorBody = String(error);
                        }
                    }
                    Main.notifyError(_('Playback error'), errorBody);
                    this._stopPlayback();
                } else if (message.type === Gst.MessageType.EOS) {
                    this._stopPlayback();
                }
            });
        }

        _handleTagMessage(message) {
            const tagList = message.parse_tag();
            const metadata = this._parseMetadataTags(tagList);
            if (metadata) {
                if (metadata.title) this._currentMetadata.title = metadata.title;
                if (metadata.artist) this._currentMetadata.artist = metadata.artist;
                if (metadata.albumArt) this._currentMetadata.albumArt = metadata.albumArt;
                if (metadata.bitrate) this._currentMetadata.bitrate = metadata.bitrate;
            }
        }

        _startMetadataUpdate() {
            this._stopMetadataUpdate();
            const interval = this._settings?.get_int('metadata-update-interval') ?? 2;
            this._metadataTimer = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                interval,
                () => {
                    this._updateMetadataDisplay();
                    return true;
                }
            );
        }

        _stopMetadataUpdate() {
            if (this._metadataTimer) {
                GLib.source_remove(this._metadataTimer);
                this._metadataTimer = null;
            }
        }

        _playStation(station) {
            try {
                this._ensurePlayer();

                this._currentMetadata = {
                    title: null,
                    artist: null,
                    albumArt: null,
                    bitrate: null
                };

                this._player.set_state(Gst.State.NULL);
                this._player.set_property('uri', station.url);
                this._player.set_state(Gst.State.PLAYING);

                station.lastPlayed = Date.now();
                this._updateStationHistory(station);

                this._nowPlaying = station;
                this._playbackState = 'playing';
                this._updatePlaybackControl();
                this._playbackControlItem.visible = true;
                const showMetadata = this._settings?.get_boolean('show-metadata') ?? true;
                this._metadataItem.visible = showMetadata;
                if (showMetadata) {
                    this._startMetadataUpdate();
                }
                Main.notify(_('Playing %s').format(stationDisplayName(station)));
            } catch (error) {
                logError(error, 'Failed to start playback');
                const errorBody = (error && typeof error === 'object' && error.message) 
                    ? String(error.message) 
                    : _('Could not start the selected station.');
                Main.notifyError(_('Playback error'), errorBody);
            }
        }

        _updateStationHistory(station) {
            const stations = loadStations();
            const stationIndex = stations.findIndex(s => s.uuid === station.uuid);
            if (stationIndex >= 0) {
                stations[stationIndex].lastPlayed = Date.now();
                saveStations(stations);
            }
        }

        _updatePlaybackControl() {
            if (this._playbackState === 'playing') {
                this._playbackControlItem.label.text = _('Pause');
            } else if (this._playbackState === 'paused') {
                this._playbackControlItem.label.text = _('Resume');
            }
        }

        _togglePlayback() {
            if (!this._player)
                return;

            if (this._playbackState === 'playing') {
                this._player.set_state(Gst.State.PAUSED);
                this._playbackState = 'paused';
                this._updatePlaybackControl();
            } else if (this._playbackState === 'paused') {
                this._player.set_state(Gst.State.PLAYING);
                this._playbackState = 'playing';
                this._updatePlaybackControl();
            }
        }

        _stopPlayback() {
            if (!this._player)
                return;

            this._player.set_state(Gst.State.NULL);
            this._nowPlaying = null;
            this._playbackState = 'stopped';
            this._playbackControlItem.visible = false;
            this._metadataItem.visible = false;
            this._stopMetadataUpdate();
            this._currentMetadata = {
                title: null,
                artist: null,
                albumArt: null
            };
            this._refreshStationsMenu();
        }

        destroy() {
            if (this._playbackState !== 'stopped') {
                this._stopPlayback();
            }

            this._stopMetadataUpdate();

            if (this._bus) {
                if (this._busHandlerId) {
                    this._bus.disconnect(this._busHandlerId);
                    this._busHandlerId = null;
                }
                this._bus.remove_signal_watch();
                this._bus = null;
            }

            if (this._player) {
                try {
                    this._player.set_state(Gst.State.NULL);
                } catch (e) {
                }
                this._player = null;
            }

            super.destroy();
        }
    });

Indicator._gstInitialized = false;

export default class YetAnotherRadioExtension extends Extension {
    enable() {
        ensureStorageFile();
        const stations = loadStations();

        this._settings = this.getSettings('org.gnome.shell.extensions.yetanotherradio');

        this._indicator = new Indicator(stations, () => this._openPreferences(), this.path, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._monitor = this._watchStationsFile();
    }

    _watchStationsFile() {
        const file = Gio.File.new_for_path(STORAGE_PATH);
        const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorHandlerId = monitor.connect('changed', () => {
            this._indicator?.setStations(loadStations());
        });
        return monitor;
    }

    _openPreferences() {
        if (Main.extensionManager?.openExtensionPrefs) {
            Main.extensionManager.openExtensionPrefs(this.uuid, '', 0);
        } else if (ExtensionUtils?.openPrefs) {
            ExtensionUtils.openPrefs(this.uuid);
        }
    }

    disable() {
        if (this._monitor) {
            if (this._monitorHandlerId) {
                this._monitor.disconnect(this._monitorHandlerId);
                this._monitorHandlerId = null;
            }
            this._monitor.cancel();
            this._monitor = null;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
    }
}
