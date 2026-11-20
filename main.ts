import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, Vault } from 'obsidian';
import { simpleGit, SimpleGit, CleanOptions, SimpleGitOptions, StatusResult, DiffResult } from 'simple-git';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async';
import { analyzeDiff, digestSummary, digestDetails, fitSubject, fitBody, MAX_DIGEST_LINES, NoteDigest } from './digest';

// Message of the stash created around a pull; identifies our own entries only.
const SYNC_STASH_MESSAGE = 'vault-digest autostash';

let simpleGitOptions: Partial<SimpleGitOptions>;
let git: SimpleGit;

type NoticeLevelSetting = 'ALL' | 'WARNING' | 'ERROR';
type LegacyNoticeLevelSetting = NoticeLevelSetting | 'WARNINGS';
type NoticeSeverity = 'INFO' | 'WARNING' | 'ERROR';


interface GHSyncSettings {
	remoteURL: string;
	gitLocation: string;
	syncinterval: number;
	isSyncOnLoad: boolean;
	checkStatusOnLoad: boolean;
	noticeLevel: NoticeLevelSetting;
	showSyncSuccessNotice: boolean;
}

const DEFAULT_SETTINGS: GHSyncSettings = {
	remoteURL: '',
	gitLocation: '',
	syncinterval: 0,
	isSyncOnLoad: false,
	checkStatusOnLoad: true,
	noticeLevel: 'ALL',
	showSyncSuccessNotice: true,
}


export default class GHSyncPlugin extends Plugin {

	settings: GHSyncSettings;

	// True while the git mergetool window is open: syncs are held meanwhile.
	private mergetoolOpen = false;

	private shouldShowNotice(severity: NoticeSeverity): boolean {
		switch (this.settings.noticeLevel) {
			case 'ERROR':
				return severity === 'ERROR';
			case 'WARNING':
				return severity === 'WARNING' || severity === 'ERROR';
			case 'ALL':
			default:
				return true;
		}
	}

	private showNotice(message: unknown, severity: NoticeSeverity, timeout?: number): void {
		if (!this.shouldShowNotice(severity)) {
			return;
		}

		const text = message instanceof Error ? message.message : String(message);
		new Notice(text, timeout);
	}

	private formatDiffFiles(diff: DiffResult | undefined): string[] {
		if (!diff) {
			return [];
		}
		return diff.files.map((f) => {
			const stats = 'insertions' in f ? " (+" + f.insertions + " -" + f.deletions + ")" : " (binary)";
			return f.file + stats;
		});
	}

	private showSyncSuccessNotice(pushed?: DiffResult, pulled?: DiffResult): void {
		if (!this.settings.showSyncSuccessNotice) {
			return;
		}

		const maxListed = 5;
		const lines: string[] = ['github sync successful'];
		const section = (arrow: string, label: string, files: string[]) => {
			if (files.length === 0) {
				return;
			}
			lines.push(arrow + " " + files.length + " " + label);
			for (const f of files.slice(0, maxListed)) {
				lines.push("\t" + f);
			}
			if (files.length > maxListed) {
				lines.push("\t... and " + (files.length - maxListed) + " more");
			}
		};
		section("\u2191", "pushed", this.formatDiffFiles(pushed));
		section("\u2193", "pulled", this.formatDiffFiles(pulled));

		this.showNotice(lines.join("\n"), 'INFO', lines.length > 1 ? 8000 : undefined);
	}

	// One extra git call, markdown only, skipped for big diffs: keeps sync fast.
	// Any failure falls back to the plain message.
	private async computeDigest(summary: DiffResult | undefined): Promise<NoteDigest | undefined> {
		if (!summary || summary.insertions + summary.deletions > MAX_DIGEST_LINES) {
			return undefined;
		}
		try {
			const diff = await git.raw([
				'-c', 'core.quotepath=false',
				'diff', '--cached', '-U0', '--no-color', '--no-ext-diff',
				'--src-prefix=a/', '--dst-prefix=b/',
				'--', '*.md',
			]);
			return analyzeDiff(diff);
		} catch (e) {
			return undefined;
		}
	}

	private buildCommitMessage(status: StatusResult, diff: DiffResult | undefined, digest: NoteDigest | undefined, hostname: string): string[] {
		const entries: string[] = [];
		const counts: string[] = [];

		const stats = new Map<string, string>();
		for (const f of diff?.files ?? []) {
			stats.set(f.file, 'insertions' in f ? " (+" + f.insertions + " -" + f.deletions + ")" : " (binary)");
		}

		const add = (label: string, code: string, files: string[]) => {
			if (files.length === 0) {
				return;
			}
			counts.push(files.length + " " + label);
			for (const f of files) {
				entries.push(code + " " + f + (stats.get(f) ?? ""));
			}
		};

		const renamed = status.renamed.map((r) => r.from + " -> " + r.to);
		const created = Array.from(new Set([...status.created, ...status.not_added]));
		add("added", "A", created);
		add("modified", "M", status.modified);
		add("deleted", "D", status.deleted);
		add("renamed", "R", renamed);

		const total = diff ? " +" + diff.insertions + " -" + diff.deletions : "";
		const digestParts = digest ? digestSummary(digest) : [];
		const subjectParts = counts.length > 0 ? [counts.join(", ") + total, ...digestParts] : digestParts;
		const subject = fitSubject("vault: sync from " + hostname, subjectParts);

		// Body: digest details first, then the file list, within a size budget.
		const lines: string[] = digest ? digestDetails(digest) : [];
		if (lines.length > 0 && entries.length > 0) {
			lines.push("");
		}
		lines.push(...entries);
		const body = fitBody(lines);

		return body.length > 0 ? [subject, body.join("\n")] : [subject];
	}

	// Drops stash entries left by an earlier sync whose conflicts are now resolved.
	// Kept if conflict markers are still staged: the stash is then the only clean copy.
	private async dropResolvedSyncStash(): Promise<void> {
		try {
			const list = await git.raw(['stash', 'list', '--format=%gd %s']);
			const refs = list.split("\n")
				.filter((l) => l.includes(SYNC_STASH_MESSAGE))
				.map((l) => l.split(" ")[0]);
			if (refs.length === 0) {
				return;
			}
			const withMarkers = await git.raw(['diff', '--cached', '-U0', '--no-color', '--name-only', '-G', '^<<<<<<< ']);
			if (withMarkers.trim() !== "") {
				this.showNotice("Vault Digest: conflict markers are still present, your stash is kept (git stash list).", 'WARNING', 10000);
				return;
			}
			for (const ref of refs.reverse()) {
				await git.raw(['stash', 'drop', ref]);
			}
		} catch (e) {
			// Best effort: a leftover stash is harmless.
		}
	}

	private initGit(): void {
		simpleGitOptions = {
			//@ts-ignore
		    baseDir: this.app.vault.adapter.getBasePath(),
		    binary: this.settings.gitLocation + "git",
		    maxConcurrentProcesses: 6,
		    trimmed: false,
		};
		git = simpleGit(simpleGitOptions);
	}

	// Runs the git binary directly (no tty, no prompt). The PATH is completed
	// because Obsidian launched from the Dock does not inherit the shell PATH,
	// and merge tools such as `code` live in /usr/local/bin or /opt/homebrew/bin.
	private runGit(args: string[]): Promise<string> {
		const { execFile } = require("child_process");
		const os = require("os");
		const path = require("path");
		//@ts-ignore
		const cwd: string = this.app.vault.adapter.getBasePath();
		const extra = os.platform() === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
		const env = {
			...process.env,
			PATH: [process.env.PATH, ...extra].filter(Boolean).join(path.delimiter),
			GIT_TERMINAL_PROMPT: "0",
		};
		return new Promise((resolve, reject) => {
			execFile(this.settings.gitLocation + "git", args, { cwd, env, maxBuffer: 10 * 1024 * 1024 },
				(err: Error | null, stdout: string, stderr: string) => {
					if (err) {
						reject(new Error(stderr || err.message));
					} else {
						resolve(stdout);
					}
				});
		});
	}

	// Opens the merge tool configured in git (merge.tool); opendiff on macOS if none.
	async ResolveConflicts(): Promise<void> {
		if (this.mergetoolOpen) {
			return;
		}
		this.initGit();

		const status = await git.status().catch(() => undefined);
		if (!status) {
			this.showNotice("Vault is not a Git repo or git binary cannot be found.", 'ERROR', 10000);
			return;
		}
		if (status.conflicted.length === 0) {
			this.showNotice("No conflicts to resolve.", 'INFO');
			return;
		}

		const configured = (await git.raw(['config', '--get', 'merge.tool']).catch(() => "")).trim();
		const tool = configured || (require("os").platform() === "darwin" ? "opendiff" : "");
		if (!tool) {
			this.showNotice("No git merge tool configured. Run: git config --global merge.tool <tool> (for example vscode, meld or kdiff3). The conflicted files are opened so you can edit them.", 'WARNING', 15000);
			for (const c of status.conflicted) {
				this.app.workspace.openLinkText("", c, true);
			}
			return;
		}

		this.showNotice("Opening git mergetool (" + tool + ")...", 'INFO');
		this.mergetoolOpen = true;
		try {
			await this.runGit([
				'-c', 'mergetool.keepBackup=false',
				'mergetool', '--no-prompt',
				...(configured ? [] : ['--tool=' + tool]),
			]);
		} catch (e) {
			// Non-zero exit: the tool was closed without resolving every file.
		} finally {
			this.mergetoolOpen = false;
		}

		const after = await git.status().catch(() => undefined);
		const unresolved = after ? await this.findUnresolvedConflicts(after.conflicted) : [];
		if (unresolved.length > 0) {
			this.reportConflicts(unresolved, undefined, false);
			return;
		}
		this.showNotice("Conflicts resolved, syncing...", 'INFO');
		await this.SyncNotes();
	}

	// Conflicted files that still contain git conflict markers (not yet resolved).
	private async findUnresolvedConflicts(conflicted: string[]): Promise<string[]> {
		const fs = require("fs").promises;
		const path = require("path");
		//@ts-ignore
		const base: string = this.app.vault.adapter.getBasePath();
		const unresolved: string[] = [];
		for (const file of conflicted) {
			try {
				const text: string = await fs.readFile(path.join(base, file), "utf8");
				if (/^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text)) {
					unresolved.push(file);
				}
			} catch (e) {
				// Deleted or unreadable (e.g. delete/modify conflict): counts as unresolved.
				unresolved.push(file);
			}
		}
		return unresolved;
	}

	private reportConflicts(conflicted: string[], note?: string, openFiles: boolean = true): void {
		let conflictMsg = "Merge conflicts in:";
		for (const c of conflicted) {
			conflictMsg += "\n\t" + c;
		}
		conflictMsg += "\nSync is suspended until these conflicts are resolved.";
		if (note) {
			conflictMsg += "\n" + note;
		}
		if (this.shouldShowNotice('WARNING')) {
			const fragment = createFragment((f) => {
				const text = f.createDiv({ text: conflictMsg });
				text.style.whiteSpace = "pre-line";
				const button = f.createEl("button", { text: "Resolve with git mergetool" });
				button.addEventListener("click", () => { void this.ResolveConflicts(); });
			});
			new Notice(fragment, 15000);
		}
		// A new conflict opens the git merge tool right away; suspended retries do not.
		if (openFiles) {
			void this.ResolveConflicts();
		}
	}

	async SyncNotes()
	{
		const remote = this.settings.remoteURL.trim();

		if (this.mergetoolOpen) {
			this.showNotice("Conflict resolution in progress: close the merge tool first.", 'INFO');
			return;
		}

		this.initGit();

		let os = require("os");
		let hostname = os.hostname();

		let statusResult = await git.status().catch((e) => {
			this.showNotice("Vault is not a Git repo or git binary cannot be found.", 'ERROR', 10000);
			return; })

		if (!statusResult) {
			return;
		}

		// Suspend the sync while conflicts are unresolved: nothing is committed,
		// pulled or pushed until the conflict markers are gone.
		if (statusResult.conflicted.length > 0) {
			const unresolved = await this.findUnresolvedConflicts(statusResult.conflicted);
			if (unresolved.length > 0) {
				// Files were already opened when the conflict appeared: do not reopen
				// tabs on every manual or scheduled sync attempt.
				this.reportConflicts(unresolved, undefined, false);
				return;
			}
		}

		//@ts-ignore
		let clean = statusResult.isClean();

		// configure remote
		try {
			await git.removeRemote('origin').catch((e) => { this.showNotice(e, 'ERROR', 10000); });
			await git.addRemote('origin', remote).catch((e) => { this.showNotice(e, 'ERROR', 10000); });
		}
		catch (e) {
			this.showNotice(e, 'ERROR', 10000);
			return;
		}
		// check if remote url valid by fetching
		try {
			await git.fetch();
		} catch (e) {
			this.showNotice(String(e) + "\nVault Digest: Invalid remote URL.", 'ERROR', 10000);
			return;
		}

		// remote changes about to be pulled (merge-base..origin/main)
		const pulledDiff = await git.diffSummary(['HEAD...origin/main']).catch(() => undefined);

		// Behind the remote with local edits: stash them, rebase onto the remote, then
		// unstash, so the new commit is made on top of up-to-date history.
		// Unstash conflict: the stash is kept and dropped automatically by the next
		// sync once the conflict is resolved. Any other failure: fall back to the
		// commit-then-pull flow below.
		let pulled = false;
		if (!clean) {
			const behind = await git.raw(['rev-list', '--count', 'HEAD..origin/main'])
				.then((r) => parseInt(r.trim(), 10) || 0)
				.catch(() => 0);
			if (behind > 0) {
				const stashed = await git.stash(['push', '--include-untracked', '-m', SYNC_STASH_MESSAGE])
					.then((out) => !out.includes('No local changes'))
					.catch(() => undefined);
				if (stashed !== undefined) {
					try {
						await git.pull('origin', 'main', { '--rebase': null });
						pulled = true;
					} catch (e) {
						await git.rebase(['--abort']).catch(() => {});
					}
					if (stashed) {
						try {
							await git.stash(['pop']);
						} catch (e) {
							// Conflicts while restoring local edits: git keeps the stash entry.
							const popStatus = await git.status().catch(() => undefined);
							if (popStatus && popStatus.conflicted.length > 0) {
								this.reportConflicts(popStatus.conflicted,
									"Your local edits are kept in a git stash and are dropped automatically once the conflicts are resolved and you sync again.");
							} else {
								this.showNotice(String(e) + "\nVault Digest: your local edits are kept in a git stash (git stash list).", 'ERROR', 10000);
							}
							return;
						}
					}
					if (pulled) {
						const afterPull = await git.status().catch(() => undefined);
						if (!afterPull) {
							return;
						}
						statusResult = afterPull;
					}
				}
			}
		}

		let pushedDiff: DiffResult | undefined;

		// git add .
		// git commit -m "vault: sync from <hostname> (<summary>)" -m "<file list>"
		if (!clean) {
			try {
				await git.add("./*");
				pushedDiff = await git.diffSummary(['--cached']).catch(() => undefined);
				await this.dropResolvedSyncStash();
				const digest = await this.computeDigest(pushedDiff);
				await git.commit(this.buildCommitMessage(statusResult, pushedDiff, digest, hostname));
		    } catch (e) {
		    	this.showNotice(e, 'ERROR', 10000);
		    	return;
		    }
		}

		// git pull --rebase origin main (linear history, no merge commits)
		// on rebase conflict: abort, then retry as a merge so conflicts can be resolved as before
		if (!pulled) {
		    try {
		    	try {
		    		await git.pull('origin', 'main', { '--rebase': null });
		    	} catch (rebaseError) {
		    		await git.rebase(['--abort']).catch(() => {});
		    		await git.pull('origin', 'main', { '--no-rebase': null });
		    	}
		    } catch (e) {
		    	let conflictStatus = await git.status().catch((error) => { this.showNotice(error, 'ERROR', 10000); return; });
		    	if (!conflictStatus) {
		    		return;
		    	}
		    	this.reportConflicts(conflictStatus.conflicted);
		    	return;
		    }
		}

		// resolve merge conflicts
		// git push origin main
	    if (!clean) {
		    try {
		    	await git.push('origin', 'main', ['-u']);
		    } catch (e) {
		    	this.showNotice(e, 'ERROR', 10000);
		    	return;
			}
	    }

		this.showSyncSuccessNotice(clean ? undefined : pushedDiff, pulledDiff);
	}

	async CheckStatusOnStart()
	{
		// check status
		try {
			simpleGitOptions = {
				//@ts-ignore
			    baseDir: this.app.vault.adapter.getBasePath(),
			    binary: this.settings.gitLocation + "git",
			    maxConcurrentProcesses: 6,
			    trimmed: false,
			};
			git = simpleGit(simpleGitOptions);

			//check for remote changes
			// git branch --set-upstream-to=origin/main main
			await git.branch({'--set-upstream-to': 'origin/main'});
			let statusUponOpening = await git.fetch().status();
			if (statusUponOpening.behind > 0)
			{
				// Automatically sync if needed
				if (this.settings.isSyncOnLoad == true)
				{
					this.SyncNotes();
				}
				else
				{
					this.showNotice("Vault Digest: " + statusUponOpening.behind + " commits behind remote.\nClick the GitHub ribbon icon to sync.", 'WARNING');
				}
			}
			else
			{
				this.showNotice("Vault Digest: up to date with remote.", 'INFO');
			}
		} catch (e) {
			// don't care
			// based
		}
	}

	async onload() {
		await this.loadSettings();

		const ribbonIconEl = this.addRibbonIcon('github', 'Sync with Remote', (evt: MouseEvent) => {
			this.SyncNotes();
		});
		ribbonIconEl.addClass('gh-sync-ribbon');

		this.addCommand({
			id: 'resolve-conflicts',
			name: 'Resolve conflicts with git mergetool',
			callback: () => {
				void this.ResolveConflicts();
			}
		});

		this.addCommand({
			id: 'github-sync-command',
			name: 'Sync with Remote',
			callback: () => {
				this.SyncNotes();
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GHSyncSettingTab(this.app, this));

		if (!isNaN(this.settings.syncinterval))
		{
			let interval: number = this.settings.syncinterval;
			if (interval >= 1)
			{
				try {
					setIntervalAsync(async () => {
						await this.SyncNotes();
					}, interval * 60 * 1000);
					//this.registerInterval(setInterval(this.SyncNotes, interval * 6 * 1000));
					this.showNotice("Auto sync enabled", 'INFO');
				} catch (e) {
					
				}
			}
		}

		if (this.settings.checkStatusOnLoad)
		{
			this.CheckStatusOnStart();
		}
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if ((this.settings.noticeLevel as LegacyNoticeLevelSetting) === 'WARNINGS') {
			this.settings.noticeLevel = 'WARNING';
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GHSyncSettingTab extends PluginSettingTab {
	plugin: GHSyncPlugin;

	constructor(app: App, plugin: GHSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		const howto = containerEl.createEl("div", { cls: "howto" });
		howto.createEl("div", { text: "How to use this plugin", cls: "howto_title" });
		howto.createEl("small", { text: "Grab your GitHub repository's HTTPS or SSH url and paste it into the settings here. If you're not authenticated, the first sync with this plugin should prompt you to authenticate. If you've already setup SSH on your device with GitHub, you won't need to authenticate - just paste your repo's SSH url into the settings here.", cls: "howto_text" });
		howto.createEl("br");
        const linkEl = howto.createEl('p');
        linkEl.createEl('span', { text: 'See the ' });
        linkEl.createEl('a', { href: 'https://github.com/kubeli-lab/obsidian-github-sync/blob/main/README.md', text: 'README' });
        linkEl.createEl('span', { text: ' for more information and troubleshooting.' });

		new Setting(containerEl)
			.setName('Remote URL')
			.setDesc('')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.remoteURL)
				.onChange(async (value) => {
					this.plugin.settings.remoteURL = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text'));

		new Setting(containerEl)
			.setName('git binary location')
			.setDesc('This is optional! Set this only if git is not findable via your system PATH, then provide its location here. See README for more info.')
			.addText(text => text
				.setPlaceholder('')
				.setValue(this.plugin.settings.gitLocation)
				.onChange(async (value) => {
					this.plugin.settings.gitLocation = value;
					await this.plugin.saveSettings();
				})
        	.inputEl.addClass('my-plugin-setting-text2'));

		new Setting(containerEl)
			.setName('Notice level')
			.setDesc('Choose which Vault Digest notices are shown in the Obsidian UI.')
			.addDropdown((dropdown) => dropdown
				.addOption('ALL', 'ALL')
				.addOption('WARNING', 'WARNING')
				.addOption('ERROR', 'ERROR')
				.setValue(this.plugin.settings.noticeLevel)
				.onChange(async (value: NoticeLevelSetting) => {
					this.plugin.settings.noticeLevel = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Hide Success Message')
			.setDesc('Hide the single success notice shown when a sync finishes successfully.')
			.addToggle((toggle) => toggle
				.setValue(!this.plugin.settings.showSyncSuccessNotice)
				.onChange(async (value) => {
					this.plugin.settings.showSyncSuccessNotice = !value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Check status on startup')
			.setDesc('Check to see if you are behind remote when you start Obsidian.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.checkStatusOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.checkStatusOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync on startup')
			.setDesc('Automatically sync with remote when you start Obsidian if there are unsynced changes.')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.isSyncOnLoad)
				.onChange(async (value) => {
					this.plugin.settings.isSyncOnLoad = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto sync at interval')
			.setDesc('Set minute interval after which your vault is synced automatically. Auto sync is disabled if this field is left empty or not a positive integer. Restart Obsidan to take effect.')
			.addText(text => text
				.setValue(String(this.plugin.settings.syncinterval))
				.onChange(async (value) => {
					this.plugin.settings.syncinterval = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
