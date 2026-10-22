import St from 'gi://St';
import Clutter from 'gi://Clutter';

// Motion helpers preserve the indicator as the owner of actors and lifecycle state.
prefersReducedMotion(indicator)) {
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

hasMotion(indicator)) {
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

ease(indicator, actor, props = {})actor, props = {}

animateBadgePop(indicator)) {
        if (!indicator._label || !indicator.hasMotion())
            return;
        indicator._label.set_pivot_point(0.5, 0.5);
        indicator._label.scale_x = 0.55;
        indicator._label.scale_y = 0.55;
        indicator._label.opacity = 180;
        indicator._ease(indicator._label, {
            scale_x: 1.45,
            scale_y: 1.45,
            opacity: 255,
            time: 140,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                indicator._ease(indicator._label, {
                    scale_x: 0.92,
                    scale_y: 0.92,
                    time: 90,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => {
                        indicator._ease(indicator._label, {
                            scale_x: 1.0,
                            scale_y: 1.0,
                            time: 110,
                            mode: Clutter.AnimationMode.EASE_OUT_BACK,
                        });
                    },
                });
            },
        });
    }

animateIconPulse(indicator)) {
        if (!indicator._icon || !indicator.hasMotion())
            return;
        indicator._icon.set_pivot_point(0.5, 0.5);
        indicator._icon.translation_y = 0;
        indicator._ease(indicator._icon, {
            scale_x: 1.35,
            scale_y: 1.35,
            translation_y: -3,
            time: 120,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
            onComplete: () => {
                indicator._ease(indicator._icon, {
                    scale_x: 0.88,
                    scale_y: 0.88,
                    translation_y: 1,
                    time: 100,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => {
                        indicator._ease(indicator._icon, {
                            scale_x: 1.0,
                            scale_y: 1.0,
                            translation_y: 0,
                            time: 130,
                            mode: Clutter.AnimationMode.EASE_OUT_BACK,
                        });
                    },
                });
            },
        });
    }

startRefreshSpin(indicator)) {
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

stopRefreshSpin(indicator)) {
        const icon = indicator._refreshIcon;
        if (!icon) return;
        try { icon.remove_all_transitions(); icon.ease({ rotation_angle_z: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); } catch (e) { try { icon.rotation_angle_z = 0; } catch (ee) {} }
    }

animateHeaderEntrance(indicator)) {
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

addButtonHoverScale(indicator, button)button) {
        if (!button || !indicator.hasMotion()) return;
        try {
            button.set_pivot_point(0.5, 0.5);
            button.connect('enter-event', () => { if (!indicator.hasMotion() || indicator._destroyed) return; indicator._ease(button, { scale_x: 1.06, scale_y: 1.06, time: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); });
            button.connect('leave-event', () => { if (indicator._destroyed) return; indicator._ease(button, { scale_x: 1, scale_y: 1, time: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); });
        } catch (e) {}
    }

