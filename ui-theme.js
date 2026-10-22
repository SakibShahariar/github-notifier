import GLib from 'gi://GLib';
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
    // Neutral fallback — never -st-accent-color. Dynamic path reads live ~/.config/matugen/matugen-colors.css
    const fallback = {
        background: '#1a1a1a',
        error: '#ff6b6b',
        error_container: '#8b0000',
        on_error_container: '#ffcccc',
        on_primary: '#ffffff',
        on_primary_container: '#e8e8e8',
        on_secondary_container: '#e0e0e0',
        on_surface: '#e0e0e0',
        on_surface_variant: '#b0b0b0',
        on_tertiary_container: '#e8e8e8',
        outline: '#888888',
        outline_variant: '#444444',
        primary: '#88aaff',
        primary_container: '#334466',
        secondary: '#aaaaaa',
        secondary_container: '#444455',
        surface: '#1a1a1a',
        surface_container: '#222222',
        surface_container_high: '#2a2a2a',
        tertiary: '#aa88cc',
        tertiary_container: '#443355',
    };
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'matugen', 'matugen-colors.css']);
    try {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null)) return fallback;
        const [ok, contents] = file.load_contents(null);
        if (!ok) return fallback;
        const text = new TextDecoder().decode(contents);
        const map = {};
        const re = /--([\w_]+)\s*:\s*([^;]+);/g;
        let m;
        while ((m = re.exec(text)) !== null) map[m[1]] = m[2].trim();
        const get = k => map[k] || fallback[k];
        return {
            background: get('background'),
            error: get('error'),
            error_container: get('error_container'),
            on_error_container: get('on_error_container'),
            on_primary: get('on_primary'),
            on_primary_container: get('on_primary_container'),
            on_secondary_container: get('on_secondary_container'),
            on_surface: get('on_surface'),
            on_surface_variant: get('on_surface_variant'),
            on_tertiary_container: get('on_tertiary_container'),
            outline: get('outline'),
            outline_variant: get('outline_variant'),
            primary: get('primary'),
            primary_container: get('primary_container'),
            secondary: get('secondary'),
            secondary_container: get('secondary_container'),
            surface: get('surface'),
            surface_container: get('surface_container'),
            surface_container_high: get('surface_container_high'),
            tertiary: get('tertiary'),
            tertiary_container: get('tertiary_container'),
        };
    } catch (e) {
        return fallback;
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
