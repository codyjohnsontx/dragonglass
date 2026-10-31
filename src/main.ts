import { Plugin, WorkspaceLeaf } from 'obsidian';
import { DragonglassCore } from './core';
import { DEFAULT_SETTINGS, DragonglassSettings, mergeSettings } from './settings';
import { ChatView, VIEW_TYPE_CHAT } from './ui/chat-view';
import { DragonglassSettingTab } from './ui/settings-tab';

export default class DragonglassPlugin extends Plugin {
	settings: DragonglassSettings = DEFAULT_SETTINGS;
	core!: DragonglassCore;

	async onload(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
		this.core = new DragonglassCore(this.app, this, this.settings, () => this.saveSettings());

		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this.core, (id) => {
			this.settings.lastConversationId = id;
			void this.saveSettings();
		}));

		this.addRibbonIcon('gem', 'Open Dragonglass chat', () => void this.activateView());
		this.addCommand({ id: 'open-chat', name: 'Open chat', callback: () => void this.activateView() });
		this.addSettingTab(new DragonglassSettingTab(this.app, this));
	}

	onunload(): void {
		this.core.dispose();
		void this.core.store.flush();
	}

	async saveSettings(): Promise<void> {
		this.core?.updateSettings(this.settings);
		await this.saveData(this.settings);
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
		}
		void workspace.revealLeaf(leaf);
	}
}
