'use strict';

/**
 * No Screenshot Box
 *
 * Clears the GNOME Screenshot UI's initial pre-selected area and optionally
 * triggers a capture automatically when the selection drag ends.
 *
 * This extension targets GNOME Shell 45+ (ESModules-based extension API).
 */

import GLib from 'gi://GLib';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOG_PREFIX = 'NoScreenshotBox';
const SCREEN_CAPTURE_SOUND = 'screen-capture';
const DEBUG_ENABLED = (() => {
    const debugEnv = GLib.getenv('G_MESSAGES_DEBUG') ?? '';

    return GLib.getenv('NO_SCREENSHOT_BOX_DEBUG') === '1' ||
        debugEnv === 'all' ||
        debugEnv.split(':').includes(LOG_PREFIX);
})();

class NoScreenshotBoxController {
    constructor(settings) {
        this._settings = settings;
        this._removePreselectedBox = true;
        this._screenshotOnRelease = true;
        this._muteScreenshotSound = false;
        this._injectionManager = null;
        this._areaSelector = null;
        this._retryId = 0;
        this._selectionRectOpacity = null;
        this._handleOpacities = null;
        this._attemptCount = 0;
        this._capturing = false;
    }

    enable() {
        this._attemptCount = 0;
        this._capturing = false;
        this._handleOpacities = new Map();
        this._injectionManager = new InjectionManager();

        this._settings?.disconnectObject(this);
        this._refreshRemovePreselectedBox();
        this._refreshScreenshotOnRelease();
        this._refreshMuteScreenshotSound();
        this._settings?.connectObject(
            'changed::remove-preselected-box',
            () => {
                this._refreshRemovePreselectedBox();
                if (this._areaSelector)
                    this._applyPatch(this._areaSelector);
            },
            this);
        this._settings?.connectObject(
            'changed::screenshot-on-release',
            () => this._refreshScreenshotOnRelease(),
            this);
        this._settings?.connectObject(
            'changed::mute-screenshot-sound',
            () => this._refreshMuteScreenshotSound(),
            this);

        this._patchSoundPlayer();
        this._patchWhenReady();
    }

    disable() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }

        this._restore();
        this._injectionManager?.clear();
        this._settings?.disconnectObject(this);

        this._injectionManager = null;
        this._handleOpacities = null;
        this._selectionRectOpacity = null;
        this._capturing = false;
    }

    _log(message) {
        if (!DEBUG_ENABLED)
            return;

        console.debug(`${LOG_PREFIX}: ${message}`);
    }

    _refreshScreenshotOnRelease() {
        this._screenshotOnRelease = this._settings?.get_boolean('screenshot-on-release') ?? true;
    }

    _refreshRemovePreselectedBox() {
        this._removePreselectedBox = this._settings?.get_boolean('remove-preselected-box') ?? true;
    }

    _refreshMuteScreenshotSound() {
        this._muteScreenshotSound =
            this._settings?.get_boolean('mute-screenshot-sound') ?? false;
    }

    _patchSoundPlayer() {
        const soundPlayer = global.display.get_sound_player();
        const originalPlayFromTheme = soundPlayer?.play_from_theme;

        if (!originalPlayFromTheme || !this._injectionManager) {
            this._log('Unable to find the screenshot sound player');
            return;
        }

        const controller = this;
        this._injectionManager.overrideMethod(
            soundPlayer,
            'play_from_theme',
            originalMethod => {
                const playFromTheme = originalMethod.bind(soundPlayer);

                return (name, ...args) => {
                    if (name === SCREEN_CAPTURE_SOUND && controller._muteScreenshotSound)
                        return;

                    playFromTheme(name, ...args);
                };
            });
    }

    _patchWhenReady() {
        const maxAttempts = 20;
        const attempt = () => {
            this._attemptCount++;

            const areaSelector = this._getAreaSelector();
            if (!areaSelector) {
                if (this._attemptCount === 1)
                    this._log('Screenshot UI not ready; will retry shortly');

                if (this._attemptCount >= maxAttempts) {
                    this._log('Unable to find screenshot selection actor; extension will stay inactive');
                    return true;
                }

                return false;
            }

            this._applyPatch(areaSelector);
            return true;
        };

        if (attempt())
            return;

        this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (attempt()) {
                this._retryId = 0;
                return GLib.SOURCE_REMOVE;
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _applyPatch(areaSelector) {
        this._restore();
        this._areaSelector = areaSelector;

        if (this._removePreselectedBox && areaSelector.reset && this._injectionManager) {
            this._injectionManager.overrideMethod(areaSelector, 'reset', originalReset => (...args) => {
                const result = originalReset?.apply(areaSelector, args);
                this._clearSelection(areaSelector);
                return result;
            });
        } else if (this._removePreselectedBox) {
            this._log('Area selector has no reset(); clearing selection directly');
        }

        if (this._removePreselectedBox) {
            // Show the rectangle only after the user actively starts a drag.
            areaSelector.connectObject('drag-started',
                () => this._revealSelection(areaSelector),
                this);
        }
        areaSelector.connectObject('drag-ended',
            () => this._autoCapture(areaSelector),
            this);

        if (this._removePreselectedBox)
            this._clearSelection(areaSelector);
        this._log('Patched screenshot selection reset');
    }

    _restore() {
        if (!this._areaSelector)
            return;

        const areaSelector = this._areaSelector;

        this._injectionManager?.restoreMethod(areaSelector, 'reset');
        areaSelector.disconnectObject(this);

        const selectionRect = this._getSelectionRect(areaSelector);
        if (selectionRect && this._selectionRectOpacity !== null)
            selectionRect.opacity = this._selectionRectOpacity;
        this._selectionRectOpacity = null;

        if (this._handleOpacities) {
            for (const [name, actor] of this._getHandles(areaSelector)) {
                const original = this._handleOpacities.get(name);
                if (actor && original !== undefined)
                    actor.opacity = original;
            }
            this._handleOpacities.clear();
        }

        this._areaSelector = null;
    }

    _getAreaSelector() {
        return Main?.screenshotUI?._areaSelector ?? null;
    }

    _clearSelection(areaSelector) {
        if ('_startX' in areaSelector)
            areaSelector._startX = 0;
        if ('_startY' in areaSelector)
            areaSelector._startY = 0;
        if ('_lastX' in areaSelector)
            areaSelector._lastX = 0;
        if ('_lastY' in areaSelector)
            areaSelector._lastY = 0;

        areaSelector._updateSelectionRect?.();

        if (!this._handleOpacities)
            this._handleOpacities = new Map();

        for (const [name, actor] of this._getHandles(areaSelector)) {
            if (!actor)
                continue;

            if (!this._handleOpacities.has(name))
                this._handleOpacities.set(name, actor.opacity);

            actor.opacity = 0;
        }

        const selectionRect = this._getSelectionRect(areaSelector);
        if (selectionRect) {
            if (this._selectionRectOpacity === null)
                this._selectionRectOpacity = selectionRect.opacity;

            selectionRect.opacity = 0;
        }
    }

    _revealSelection(areaSelector) {
        const selectionRect = this._getSelectionRect(areaSelector);
        if (selectionRect && this._selectionRectOpacity !== null)
            selectionRect.opacity = this._selectionRectOpacity;

        // Keep handles hidden for a cleaner outline.
        for (const [, actor] of this._getHandles(areaSelector)) {
            if (actor)
                actor.opacity = 0;
        }
    }

    _getSelectionRect(areaSelector) {
        if (areaSelector._selectionRect)
            return areaSelector._selectionRect;

        if (areaSelector._areaIndicator?.['_selectionRect'])
            return areaSelector._areaIndicator._selectionRect;

        return null;
    }

    _getHandles(areaSelector) {
        const names = [
            '_topLeftHandle',
            '_topRightHandle',
            '_bottomLeftHandle',
            '_bottomRightHandle',
        ];

        return names.map(name => [name, areaSelector[name]]);
    }

    async _autoCapture(areaSelector) {
        // Trigger capture when a selection drag finishes in area mode.
        if (!this._screenshotOnRelease)
            return;

        const screenshotUI = Main?.screenshotUI;
        if (!screenshotUI)
            return;

        if (!screenshotUI._selectionButton?.checked)
            return;

        if (!screenshotUI._shotButton?.checked)
            return;

        const [,, w, h] = areaSelector.getGeometry?.() ?? [0, 0, 0, 0];
        if (w <= 2 || h <= 2)
            return;

        if (this._capturing)
            return;
        this._capturing = true;

        try {
            if (screenshotUI._saveScreenshot) {
                await screenshotUI._saveScreenshot();
                screenshotUI.close?.(true); // skip fade-out animation for speed
            } else if (screenshotUI._onCaptureButtonClicked) {
                await screenshotUI._onCaptureButtonClicked();
            }
        } catch (error) {
            this._log(`Auto capture failed: ${error}`);
        } finally {
            this._capturing = false;
        }
    }
}

export default class NoScreenshotBoxExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._controller = new NoScreenshotBoxController(this._settings);
        this._controller.enable();
    }

    disable() {
        this._controller?.disable();
        this._controller = null;
        this._settings = null;
    }
}
