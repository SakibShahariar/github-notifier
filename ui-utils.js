import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class HoverTooltipController {
    constructor() {
        this._bindings = new WeakMap();
        this._activeActor = null;
        this._pendingActor = null;
        this._timeoutId = 0;
        this._label = new St.Label({style_class: 'tooltip', visible: false, reactive: false});
        Main.layoutManager.addTopChrome(this._label);
    }

    setTooltip(actor, text) {
        if (!actor || text == null)
            return;

        try {
            actor.accessible_name = text;
        } catch (_error) {
            // Not every Clutter actor implements an accessible name.
        }

        const existing = this._bindings.get(actor);
        if (existing) {
            existing.text = text;
            return;
        }

        this._bindings.set(actor, {text});
        actor.connect('enter-event', () => {
            this._schedule(actor);
            return Clutter.EVENT_PROPAGATE;
        });
        actor.connect('leave-event', () => {
            if (this._activeActor === actor || this._pendingActor === actor)
                this._hide();
            return Clutter.EVENT_PROPAGATE;
        });
        // Mirror hover tooltips for keyboard users navigating focusable controls.
        actor.connect('key-focus-in', () => {
            this._schedule(actor);
        });
        actor.connect('key-focus-out', () => {
            if (this._activeActor === actor || this._pendingActor === actor)
                this._hide();
        });
        actor.connect('destroy', () => {
            if (this._activeActor === actor || this._pendingActor === actor)
                this._hide();
            this._bindings.delete(actor);
        });
    }

    _schedule(actor) {
        this._hide();
        this._pendingActor = actor;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 450, () => {
            this._timeoutId = 0;
            if (this._pendingActor === actor) {
                this._pendingActor = null;
                this._show(actor);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _show(actor) {
        const binding = this._bindings.get(actor);
        if (!binding || !binding.text || !actor.visible || !actor.get_stage())
            return;

        this._label.text = binding.text;
        this._label.show();

        const [actorX, actorY] = actor.get_transformed_position();
        const [, tooltipWidth] = this._label.get_preferred_width(-1);
        const [, tooltipHeight] = this._label.get_preferred_height(tooltipWidth);
        const stageWidth = global.stage.width;
        const stageHeight = global.stage.height;
        const actorWidth = actor.width;
        const actorHeight = actor.height;

        let x = actorX + (actorWidth - tooltipWidth) / 2;
        x = Math.max(4, Math.min(x, stageWidth - tooltipWidth - 4));
        let y = actorY + actorHeight + 8;
        if (y + tooltipHeight > stageHeight - 4)
            y = actorY - tooltipHeight - 8;
        y = Math.max(4, Math.min(y, stageHeight - tooltipHeight - 4));

        this._label.set_position(Math.round(x), Math.round(y));
        this._activeActor = actor;
    }

    _hide() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._pendingActor = null;
        this._activeActor = null;
        this._label.hide();
    }

    destroy() {
        this._hide();
        Main.layoutManager.removeChrome(this._label);
        this._label.destroy();
        this._bindings = new WeakMap();
    }
}

// --- Matugen helpers (same idea as update-checker@local) ---
