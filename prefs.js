'use strict';

/**
 * Preferences for No Screenshot Box.
 *
 * Uses libadwaita widgets in a preferences window provided by GNOME Shell's
 * extensions app.
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class NoScreenshotBoxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const removeRow = new Adw.SwitchRow({
            title: 'Remove preselected box',
            subtitle: "Start with an empty selection instead of GNOME Screenshot's default preselected area.",
        });

        settings.bind(
            'remove-preselected-box',
            removeRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        const captureRow = new Adw.SwitchRow({
            title: 'Screenshot on release',
            subtitle: 'Automatically capture the selected area when the drag ends.',
        });

        settings.bind(
            'screenshot-on-release',
            captureRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        const behaviorGroup = new Adw.PreferencesGroup({
            title: 'Behavior',
        });
        behaviorGroup.add(removeRow);
        behaviorGroup.add(captureRow);

        const muteSoundRow = new Adw.SwitchRow({
            title: 'Mute screenshot sound',
            subtitle: 'Mute only the screenshot sound without changing other system or application audio.',
        });

        settings.bind(
            'mute-screenshot-sound',
            muteSoundRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT);

        const soundGroup = new Adw.PreferencesGroup({
            title: 'Sound',
        });
        soundGroup.add(muteSoundRow);

        const page = new Adw.PreferencesPage({
            title: this.metadata.name,
            icon_name: 'preferences-system-symbolic',
        });
        page.add(behaviorGroup);
        page.add(soundGroup);
        window.add(page);
    }
}
