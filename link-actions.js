import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {getGitHubCliArguments, isSafeWebUrl} from './repo-utils.js';

export function openUri(indicator, uri) {
        try {
            if (!isSafeWebUrl(uri, indicator._webBase()))
                throw new Error('Refusing to open an invalid or non-HTTPS link');
            if (Gio.AppInfo.launch_default_for_uri(uri, null))
                return true;
        } catch (e) {
            logError(e, 'github-notifier: failed to open link');
        }

        const statusGeneration = indicator._setActionStatus('Could not open link — check your default browser');
        indicator._addTransientTimeout(4, () => {
            if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
            return GLib.SOURCE_REMOVE;
        });
        return false;
    }

export function githubCliLaunchConfig(indicator, item) {
        const commandArgs = getGitHubCliArguments(item, indicator._webBase());
        const ghPath = GLib.find_program_in_path('gh');
        if (!commandArgs || !ghPath)
            return null;

        const terminals = [
            {name: 'kgx', args: ['--']},
            {name: 'ptyxis', args: ['--new-window', '--']},
            {name: 'gnome-terminal', args: ['--']},
            {name: 'x-terminal-emulator', args: ['-e']},
        ];
        for (const terminal of terminals) {
            const path = GLib.find_program_in_path(terminal.name);
            if (path)
                return {argv: [path, ...terminal.args, ghPath, ...commandArgs]};
        }
        return null;
    }

export function openWithGitHubCli(indicator, item) {
        const config = githubCliLaunchConfig(indicator, item);
        if (!config) {
            const statusGeneration = indicator._setActionStatus('GitHub CLI or a supported terminal is unavailable');
            indicator._addTransientTimeout(4, () => {
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return false;
        }

        try {
            GLib.spawn_async(null, config.argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
            indicator._handleOpenedItem(item);
            return true;
        } catch (e) {
            logError(e, 'github-notifier: failed to launch GitHub CLI');
            const statusGeneration = indicator._setActionStatus(`Could not launch GitHub CLI: ${e.message}`);
            indicator._addTransientTimeout(4, () => {
                if (statusGeneration === indicator._actionStatusGeneration) indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return false;
        }
    }

