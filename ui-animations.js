import St from 'gi://St';
import Clutter from 'gi://Clutter';

// Motion helpers preserve the indicator as the owner of actors and lifecycle state.
export function prefersReducedMotion(indicator) {
        try {
            if (St.Settings && St.ReducedMotion) {
                const {reducedMotion} = St.Settings.get();
                return reducedMotion === St.ReducedMotion.REDUCE;
            }
        } catch (_e) {
            /* St.ReducedMotion is GNOME 51+ */
        }
        return false;
    }

export function hasMotion(indicator) {
        try {
            const s = St.Settings.get();
            if (s && 'enable_animations' in s && s.enable_animations === false) return false;
            if (St.ReducedMotion && s.reducedMotion === St.ReducedMotion.REDUCE) return false;
        } catch (_e) {}
        try {
            const cs = Clutter.Settings.get_default?.();
            if (cs && 'enable_animations' in cs && cs.enable_animations === false) return false;
        } catch (_e) {}
        return !indicator._prefersReducedMotion();
    }

export function ease(indicator, actor, props = {}) {
        if (!actor || indicator._destroyed || !indicator.hasMotion()) {
            if (actor && props.opacity !== undefined)
                actor.opacity = props.opacity;
            if (actor && props.scale_x !== undefined)
                actor.scale_x = props.scale_x;
            if (actor && props.scale_y !== undefined)
                actor.scale_y = props.scale_y;
            if (actor && props.translation_y !== undefined)
                actor.translation_y = props.translation_y;
            if (typeof props.onComplete === 'function')
                props.onComplete();
            return;
        }
        const {
            opacity,
            scale_x: scaleX,
            scale_y: scaleY,
            translation_y: translationY,
            time = 150,
            mode = Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete,
        } = props;
        const params = {duration: time, mode};
        if (opacity !== undefined)
            params.opacity = opacity;
        if (scaleX !== undefined)
            params.scale_x = scaleX;
        if (scaleY !== undefined)
            params.scale_y = scaleY;
        if (translationY !== undefined)
            params.translation_y = translationY;
        if (typeof onComplete === 'function')
            params.onComplete = onComplete;
        try {
            actor.ease(params);
        } catch (_e) {
            if (opacity !== undefined)
                actor.opacity = opacity;
            if (scaleX !== undefined)
                actor.scale_x = scaleX;
            if (scaleY !== undefined)
                actor.scale_y = scaleY;
            if (translationY !== undefined)
                actor.translation_y = translationY;
            if (typeof onComplete === 'function')
                onComplete();
        }
    }

/** Cancel any badge animation and leave the panel count at its neutral transform. */
export function resetBadgeTransform(indicator) {
        const label = indicator._label;
        if (!label)
            return;
        indicator._badgeAnimationGeneration = (indicator._badgeAnimationGeneration ?? 0) + 1;
        try {
            label.remove_all_transitions();
        } catch (_e) {
            /* actor may already be disposed */
        }
        label.scale_x = 1.0;
        label.scale_y = 1.0;
        label.opacity = 255;
    }

export function animateBadgePop(indicator) {
        const label = indicator._label;
        if (!label || !indicator.hasMotion())
            return;
        // Each pop invalidates earlier chains. Without a generation guard, a
        // stale onComplete can fire after a newer animation and leave the label
        // stranded at an intermediate scale (the count renders tiny).
        const generation = (indicator._badgeAnimationGeneration ?? 0) + 1;
        indicator._badgeAnimationGeneration = generation;
        const live = () => !indicator._destroyed && indicator._badgeAnimationGeneration === generation;
        const step = (props, next) => indicator._ease(label, {
            ...props,
            onComplete: () => {
                if (live() && next)
                    next();
            },
        });

        try {
            label.remove_all_transitions();
        } catch (_e) {
            /* actor may already be disposed */
        }
        label.set_pivot_point(0.5, 0.5);
        label.scale_x = 0.55;
        label.scale_y = 0.55;
        label.opacity = 180;
        step({scale_x: 1.45, scale_y: 1.45, opacity: 255, time: 140, mode: Clutter.AnimationMode.EASE_OUT_BACK}, () =>
            step({scale_x: 0.92, scale_y: 0.92, time: 90, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD}, () =>
                step({scale_x: 1.0, scale_y: 1.0, time: 110, mode: Clutter.AnimationMode.EASE_OUT_BACK})));
    }

export function animateIconPulse(indicator) {
        const icon = indicator._icon;
        if (!icon || !indicator.hasMotion())
            return;
        const generation = (indicator._iconAnimationGeneration ?? 0) + 1;
        indicator._iconAnimationGeneration = generation;
        const live = () => !indicator._destroyed && indicator._iconAnimationGeneration === generation;
        const step = (props, next) => indicator._ease(icon, {
            ...props,
            onComplete: () => {
                if (live() && next)
                    next();
            },
        });

        try {
            icon.remove_all_transitions();
        } catch (_e) {
            /* actor may already be disposed */
        }
        icon.set_pivot_point(0.5, 0.5);
        icon.translation_y = 0;
        step({scale_x: 1.35, scale_y: 1.35, translation_y: -3, time: 120, mode: Clutter.AnimationMode.EASE_OUT_BACK}, () =>
            step({scale_x: 0.88, scale_y: 0.88, translation_y: 1, time: 100, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD}, () =>
                step({scale_x: 1.0, scale_y: 1.0, translation_y: 0, time: 130, mode: Clutter.AnimationMode.EASE_OUT_BACK})));
    }

export function startRefreshSpin(indicator) {
        const icon = indicator._refreshIcon;
        if (!icon || !indicator.hasMotion()) return;
        if (icon.get_transition?.('rotation-angle-z')) return;
        try {
            icon.set_pivot_point(0.5, 0.5);
            const loop = () => {
                if (!indicator._polling || indicator._destroyed || !icon.get_stage?.()) return;
                icon.ease({ rotation_angle_z: (icon.rotation_angle_z || 0) + 360, duration: 900, mode: Clutter.AnimationMode.LINEAR, onComplete: () => { if (indicator._polling && !indicator._destroyed) loop(); } });
            };
            loop();
        } catch (e) {}
    }

export function stopRefreshSpin(indicator) {
        const icon = indicator._refreshIcon;
        if (!icon) return;
        try { icon.remove_all_transitions(); icon.ease({ rotation_angle_z: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); } catch (e) { try { icon.rotation_angle_z = 0; } catch (ee) {} }
    }

export function animateHeaderEntrance(indicator) {
        if (!indicator.hasMotion() || !indicator._heroBox) return;
        try {
            indicator._heroBox.set_pivot_point(0.5, 0.5);
            indicator._heroBox.opacity = 0;
            indicator._heroBox.set_scale(0.96, 0.96);
            indicator._ease(indicator._heroBox, { opacity: 255, scale_x: 1, scale_y: 1, time: 280, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            if (indicator._heroIcon) {
                indicator._heroIcon.set_pivot_point(0.5, 0.5);
                indicator._heroIcon.set_scale(0.5, 0.5);
                indicator._ease(indicator._heroIcon, { scale_x: 1, scale_y: 1, time: 420, mode: Clutter.AnimationMode.EASE_OUT_BACK });
            }
        } catch (e) {}
    }

export function addButtonHoverScale(indicator, button) {
        if (!button || !indicator.hasMotion()) return;
        try {
            button.set_pivot_point(0.5, 0.5);
            button.connect('enter-event', () => { if (!indicator.hasMotion() || indicator._destroyed) return; indicator._ease(button, { scale_x: 1.06, scale_y: 1.06, time: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); });
            button.connect('leave-event', () => { if (indicator._destroyed) return; indicator._ease(button, { scale_x: 1, scale_y: 1, time: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); });
        } catch (e) {}
    }

