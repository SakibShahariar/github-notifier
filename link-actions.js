import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {getGitHubCliArguments} from './repo-utils.js';

export function openUri(indicator, uri) {
        try {
            if (Gio.AppInfo.launch_default_for_uri(uri, null))
                return true;
        } catch (e) {
            logError(e, 'github-notifier: failed to open link');
        }

        indicator._setActionStatus('Could not open link — check your default browser');
        indicator._addTransientTimeout(4, () => {
            indicator._setActionStatus('');
            return GLib.SOURCE_REMOVE;
        });
        return false;
    }

export function githubCliLaunchConfig(indicator, item) {
        const commandArgs = getGitHubCliArguments(item);
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
            indicator._setActionStatus('GitHub CLI or a supported terminal is unavailable');
            indicator._addTransientTimeout(4, () => {
                indicator._setActionStatus('');
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
            indicator._setActionStatus(`Could not launch GitHub CLI: ${e.message}`);
            indicator._addTransientTimeout(4, () => {
                indicator._setActionStatus('');
                return GLib.SOURCE_REMOVE;
            });
            return false;
        }
    }

