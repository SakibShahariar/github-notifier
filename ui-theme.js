import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';

export function hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith('#')) return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function lightenHex(hex, amount = 0x14) {
    if (!hex || !hex.startsWith('#')) return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    let r = Math.min(255, parseInt(h.slice(0, 2), 16) + amount);
    let g = Math.min(255, parseInt(h.slice(2, 4), 16) + amount);
    let b = Math.min(255, parseInt(h.slice(4, 6), 16) + amount);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

export function loadMatugenColors() {
export function loadMatugenColors() {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return null;
        const [ok, contents] = file.load_contents(null);
        if (!ok || !contents?.length)
            return null;
        const text = new TextDecoder().decode(contents);
        const map = {};
        const re = /--([\\w_]+)\\s*:\\s*([^;]+);/g;
        let match;
        while ((match = re.exec(text)) !== null)
            map[match[1]] = match[2].trim();

        const required = [
            'background', 'error', 'error_container', 'on_error_container',
            'on_primary', 'on_primary_container', 'on_secondary_container',
            'on_surface', 'on_surface_variant', 'on_tertiary_container',
            'outline', 'outline_variant', 'primary', 'primary_container',
            'secondary', 'secondary_container', 'surface', 'surface_container',
            'surface_container_high', 'tertiary', 'tertiary_container',
        ];
        if (!required.every(key => map[key]))
            return null;
        return Object.fromEntries(required.map(key => [key, map[key]]));
    } catch (e) {
        return null;
    }
}

export function buildMatugenCss(c) {
    return `
.github-notifier-hero { background-color: ${c.primary_container}; border-color: transparent; }
.github-notifier-hero-icon { color: ${c.on_primary}; }
.github-notifier-hero-title { color: ${c.on_primary_container}; }
.github-notifier-hero-meta { color: ${hexToRgba(c.on_primary_container, 0.75)}; }
.github-notifier-hero-gear { color: ${c.on_primary_container}; }
.github-notifier-hero-gear:hover { background-color: ${hexToRgba(c.secondary, 0.18)}; }
.github-notifier-hero-gear:active { background-color: ${hexToRgba(c.tertiary, 0.22)}; }
.github-notifier-banner { background-color: ${c.surface_container}; border-color: transparent; }
.github-notifier-banner-info { background-color: ${hexToRgba(c.secondary_container, 0.55)}; color: ${c.on_secondary_container}; }
.github-notifier-banner-error { background-color: ${c.error_container}; color: ${c.on_error_container}; border-color: transparent; }
.github-notifier-section-header { color: ${c.on_surface}; }
.github-notifier-separator { background-color: ${c.outline_variant}; }
.github-notifier-row:hover, .github-notifier-row:focus, .github-notifier-row:selected { background-color: ${c.surface_container_high}; }
.github-notifier-row-title { color: ${c.on_surface}; }
.github-notifier-row-detail { color: ${c.on_surface_variant}; }
.github-notifier-glyph.dim { color: ${c.secondary}; }
.github-notifier-glyph.urgent { color: ${c.primary}; }
.github-notifier-read-button { color: ${c.secondary}; }
.github-notifier-read-button:hover { background-color: ${hexToRgba(c.secondary, 0.18)}; }
.github-notifier-read-button:active { background-color: ${hexToRgba(c.tertiary, 0.22)}; }
.github-notifier-footer-button { background-color: ${c.surface_container_high}; color: ${c.on_surface}; border-color: transparent; }
.github-notifier-footer-button:hover { background-color: ${c.secondary_container}; color: ${c.on_secondary_container}; }
.github-notifier-footer-button:active { background-color: ${c.outline_variant}; }
.github-notifier-footer-button.urgent { background-color: ${c.tertiary_container}; color: ${c.on_tertiary_container}; }
.github-notifier-footer-button.urgent:hover { background-color: ${lightenHex(c.tertiary_container, 0x14)}; }
.github-notifier-empty { color: ${c.on_surface_variant}; }
.github-notifier-action-status { color: ${c.on_surface_variant}; }
.github-notifier-rate { color: ${hexToRgba(c.on_surface_variant, 0.85)}; }
`;
}


function clearMatugenStylesheet(indicator) {
    if (indicator._matugenThemeFile) {
        try {
            const stage = global.stage ?? global.display?.get_stage?.() ?? Main.layoutManager?.dummyStage ?? null;
            const theme = stage ? St.ThemeContext.get_for_stage(stage)?.get_theme() : null;
            if (theme)
                theme.unload_stylesheet(indicator._matugenThemeFile);
        } catch (e) {}
        indicator._matugenThemeFile = null;
    }
    indicator._matugenCss = null;
    try { indicator.menu?.box?.queue_relayout(); } catch (e) {}
}

export function loadMatugenColorsIfChanged(indicator, force = false) {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
        try {
            let mtime = -1;
            try {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    const info = file.query_info('standard::modification-time', Gio.FileQueryInfoFlags.NONE, null);
                    const dt = info.get_modification_time();
                    mtime = (dt && typeof dt.to_unix === 'function') ? dt.to_unix() : (dt ? dt.to_unix_utc() : -1);
                }
            } catch (e) {
                mtime = -1;
            }
            if (force || mtime !== indicator._matugenMtime || !indicator._matugenColors) {
                indicator._matugenMtime = mtime;
                indicator._matugenColors = loadMatugenColors();
                if (!indicator._matugenColors)
                    clearMatugenStylesheet(indicator);
            }
        } catch (e) {
            logError(e, 'GitHubNotifier matugen load failed');
            indicator._matugenColors = loadMatugenColors();
            if (!indicator._matugenColors)
                clearMatugenStylesheet(indicator);
        }
    }

export function applyMatugenThemeInternal(indicator, colors) {
        if (!colors) {
            clearMatugenStylesheet(indicator);
            return;
        }
        try {
            const css = buildMatugenCss(colors);
            // Fixed path — avoid creating a new file (and forced unload/load)
            // on every call. Only touch St.Theme when content actually changed.
            const cachePath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'github-notifier-matugen.css']);
            const cssChanged = css !== indicator._matugenCss;

            if (cssChanged) {
                // Robust stage lookup (Wayland/X11 differ) — mirrors update-checker@local
                let theme = null;
                try {
                    const stage = global.stage ?? global.display?.get_stage?.() ?? Main.layoutManager?.dummyStage ?? null;
                    if (stage) {
                        const ctx = St.ThemeContext.get_for_stage(stage);
                        theme = ctx?.get_theme() ?? null;
                    }
                } catch (e) {}
                if (!theme) {
                    try { theme = St.ThemeContext.get_for_stage(global.stage)?.get_theme() ?? null; } catch (e) {}
                }
                // Unload previous only when we are about to load a different one
                if (theme && indicator._matugenThemeFile) {
                    try { theme.unload_stylesheet(indicator._matugenThemeFile); } catch (e) {}
                }
                const ok = GLib.file_set_contents(cachePath, css);
                if (!ok) throw new Error('file_set_contents failed');
                const file = Gio.File.new_for_path(cachePath);
                if (theme) {
                    theme.load_stylesheet(file);
                    indicator._matugenThemeFile = file;
                    try { indicator.menu?.box?.queue_relayout(); } catch (e) {}
                } else {
                    indicator._matugenThemeFile = file;
                }
                indicator._matugenCss = css;
                log(`GitHubNotifier matugen applied primary=${colors.primary} primary_container=${colors.primary_container} -> ${cachePath}`);
            }

            // Rebuild current list so banners/rows/footer pick up new stylesheet/inline immediately if popup is open
            try {
                if (indicator.menu?.isOpen) indicator._renderList();
            } catch (e) {}
        } catch (e) {
            logError(e, 'GitHubNotifier matugen theme failed');
        }
    }

export function setupMatugenMonitor(indicator) {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
        const file = Gio.File.new_for_path(path);
        try {
            indicator._matugenMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            indicator._matugenMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT || eventType === Gio.FileMonitorEvent.CHANGED) {
                    indicator._loadMatugenColorsIfChanged(true);
                    if (indicator._matugenColors) {
                        indicator._applyMatugenThemeInternal(indicator._matugenColors);
                    } else {
                        clearMatugenStylesheet(indicator);
                    }
                }
            });
        } catch (e) {
            logError(e, 'GitHubNotifier matugen monitor failed');
        }
    }

export function removeMatugenTheme(indicator) {
        clearMatugenStylesheet(indicator);
        if (indicator._matugenDebounceId) {
            GLib.source_remove(indicator._matugenDebounceId);
            indicator._matugenDebounceId = null;
        }
        if (indicator._matugenMonitor) {
            try { indicator._matugenMonitor.cancel(); } catch (e) {}
            indicator._matugenMonitor = null;
        }
}mport GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Gio from 'gi://Gio';

export function hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith('#')) return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function lightenHex(hex, amount = 0x14) {
    if (!hex || !hex.startsWith('#')) return hex;
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    let r = Math.min(255, parseInt(h.slice(0, 2), 16) + amount);
    let g = Math.min(255, parseInt(h.slice(2, 4), 16) + amount);
    let b = Math.min(255, parseInt(h.slice(4, 6), 16) + amount);
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

export function loadMatugenColors() {
export function loadMatugenColors() {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return null;
        const [ok, contents] = file.load_contents(null);
        if (!ok || !contents?.length)
            return null;
        const text = new TextDecoder().decode(contents);
        const map = {};
        const re = /--([\\w_]+)\\s*:\\s*([^;]+);/g;
        let match;
        while ((match = re.exec(text)) !== null)
            map[match[1]] = match[2].trim();

        const required = [
            'background', 'error', 'error_container', 'on_error_container',
            'on_primary', 'on_primary_container', 'on_secondary_container',
            'on_surface', 'on_surface_variant', 'on_tertiary_container',
            'outline', 'outline_variant', 'primary', 'primary_container',
            'secondary', 'secondary_container', 'surface', 'surface_container',
            'surface_container_high', 'tertiary', 'tertiary_container',
        ];
        if (!required.every(key => map[key]))
            return null;
        return Object.fromEntries(required.map(key => [key, map[key]]));
    } catch (e) {
        return null;
    }
}

export function buildMatugenCss(c) {
    return `
.github-notifier-hero { background-color: ${c.primary_container}; border-color: transparent; }
.github-notifier-hero-icon { color: ${c.on_primary}; }
.github-notifier-hero-title { color: ${c.on_primary_container}; }
.github-notifier-hero-meta { color: ${hexToRgba(c.on_primary_container, 0.75)}; }
.github-notifier-hero-gear { color: ${c.on_primary_container}; }
.github-notifier-hero-gear:hover { background-color: ${hexToRgba(c.secondary, 0.18)}; }
.github-notifier-hero-gear:active { background-color: ${hexToRgba(c.tertiary, 0.22)}; }
.github-notifier-banner { background-color: ${c.surface_container}; border-color: transparent; }
.github-notifier-banner-info { background-color: ${hexToRgba(c.secondary_container, 0.55)}; color: ${c.on_secondary_container}; }
.github-notifier-banner-error { background-color: ${c.error_container}; color: ${c.on_error_container}; border-color: transparent; }
.github-notifier-section-header { color: ${c.on_surface}; }
.github-notifier-separator { background-color: ${c.outline_variant}; }
.github-notifier-row:hover, .github-notifier-row:focus, .github-notifier-row:selected { background-color: ${c.surface_container_high}; }
.github-notifier-row-title { color: ${c.on_surface}; }
.github-notifier-row-detail { color: ${c.on_surface_variant}; }
.github-notifier-glyph.dim { color: ${c.secondary}; }
.github-notifier-glyph.urgent { color: ${c.primary}; }
.github-notifier-read-button { color: ${c.secondary}; }
.github-notifier-read-button:hover { background-color: ${hexToRgba(c.secondary, 0.18)}; }
.github-notifier-read-button:active { background-color: ${hexToRgba(c.tertiary, 0.22)}; }
.github-notifier-footer-button { background-color: ${c.surface_container_high}; color: ${c.on_surface}; border-color: transparent; }
.github-notifier-footer-button:hover { background-color: ${c.secondary_container}; color: ${c.on_secondary_container}; }
.github-notifier-footer-button:active { background-color: ${c.outline_variant}; }
.github-notifier-footer-button.urgent { background-color: ${c.tertiary_container}; color: ${c.on_tertiary_container}; }
.github-notifier-footer-button.urgent:hover { background-color: ${lightenHex(c.tertiary_container, 0x14)}; }
.github-notifier-empty { color: ${c.on_surface_variant}; }
.github-notifier-action-status { color: ${c.on_surface_variant}; }
.github-notifier-rate { color: ${hexToRgba(c.on_surface_variant, 0.85)}; }
`;
}


function clearMatugenStylesheet(indicator) {
    if (indicator._matugenThemeFile) {
        try {
            const stage = global.stage ?? global.display?.get_stage?.() ?? Main.layoutManager?.dummyStage ?? null;
            const theme = stage ? St.ThemeContext.get_for_stage(stage)?.get_theme() : null;
            if (theme)
                theme.unload_stylesheet(indicator._matugenThemeFile);
        } catch (e) {}
        indicator._matugenThemeFile = null;
    }
    indicator._matugenCss = null;
    try { indicator.menu?.box?.queue_relayout(); } catch (e) {}
}

export function loadMatugenColorsIfChanged(indicator, force = false) {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
        try {
            let mtime = -1;
            try {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    const info = file.query_info('standard::modification-time', Gio.FileQueryInfoFlags.NONE, null);
                    const dt = info.get_modification_time();
                    mtime = (dt && typeof dt.to_unix === 'function') ? dt.to_unix() : (dt ? dt.to_unix_utc() : -1);
                }
            } catch (e) {
                mtime = -1;
            }
            if (force || mtime !== indicator._matugenMtime || !indicator._matugenColors) {
                indicator._matugenMtime = mtime;
                indicator._matugenColors = loadMatugenColors();
                if (!indicator._matugenColors)
                    clearMatugenStylesheet(indicator);
            }
        } catch (e) {
            logError(e, 'GitHubNotifier matugen load failed');
            indicator._matugenColors = loadMatugenColors();
            if (!indicator._matugenColors)
                clearMatugenStylesheet(indicator);
        }
    }

export function applyMatugenThemeInternal(indicator, colors) {
        if (!colors) {
            clearMatugenStylesheet(indicator);
            return;
        }
        try {
            const css = buildMatugenCss(colors);
            // Fixed path — avoid creating a new file (and forced unload/load)
            // on every call. Only touch St.Theme when content actually changed.
            const cachePath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'github-notifier-matugen.css']);
            const cssChanged = css !== indicator._matugenCss;

            if (cssChanged) {
                // Robust stage lookup (Wayland/X11 differ) — mirrors update-checker@local
                let theme = null;
                try {
                    const stage = global.stage ?? global.display?.get_stage?.() ?? Main.layoutManager?.dummyStage ?? null;
                    if (stage) {
                        const ctx = St.ThemeContext.get_for_stage(stage);
                        theme = ctx?.get_theme() ?? null;
                    }
                } catch (e) {}
                if (!theme) {
                    try { theme = St.ThemeContext.get_for_stage(global.stage)?.get_theme() ?? null; } catch (e) {}
                }
                // Unload previous only when we are about to load a different one
                if (theme && indicator._matugenThemeFile) {
                    try { theme.unload_stylesheet(indicator._matugenThemeFile); } catch (e) {}
                }
                const ok = GLib.file_set_contents(cachePath, css);
                if (!ok) throw new Error('file_set_contents failed');
                const file = Gio.File.new_for_path(cachePath);
                if (theme) {
                    theme.load_stylesheet(file);
                    indicator._matugenThemeFile = file;
                    try { indicator.menu?.box?.queue_relayout(); } catch (e) {}
                } else {
                    indicator._matugenThemeFile = file;
                }
                indicator._matugenCss = css;
                log(`GitHubNotifier matugen applied primary=${colors.primary} primary_container=${colors.primary_container} -> ${cachePath}`);
            }

            // Rebuild current list so banners/rows/footer pick up new stylesheet/inline immediately if popup is open
            try {
                if (indicator.menu?.isOpen) indicator._renderList();
            } catch (e) {}
        } catch (e) {
            logError(e, 'GitHubNotifier matugen theme failed');
        }
    }

export function setupMatugenMonitor(indicator) {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
        const file = Gio.File.new_for_path(path);
        try {
            indicator._matugenMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            indicator._matugenMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT || eventType === Gio.FileMonitorEvent.CHANGED) {
                    indicator._loadMatugenColorsIfChanged(true);
                    if (indicator._matugenColors) {
                        indicator._applyMatugenThemeInternal(indicator._matugenColors);
                    } else {
                        clearMatugenStylesheet(indicator);
                    }
                }
            });
        } catch (e) {
            logError(e, 'GitHubNotifier matugen monitor failed');
        }
    }

export function removeMatugenTheme(indicator) {
        if (indicator._matugenThemeFile) {
            try {
                const theme = St.ThemeContext.get_for_stage(global.stage)?.get_theme();
                if (theme) theme.unload_stylesheet(indicator._matugenThemeFile);
            } catch (e) {}
            indicator._matugenThemeFile = null;
        }
        indicator._matugenCss = null;
        if (indicator._matugenDebounceId) {
            GLib.source_remove(indicator._matugenDebounceId);
            indicator._matugenDebounceId = null;
        }
        if (indicator._matugenMonitor) {
            try { indicator._matugenMonitor.cancel(); } catch (e) {}
            indicator._matugenMonitor = null;
        }
    }