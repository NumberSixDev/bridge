import { randomUUID } from 'crypto';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChatInputCommandInteraction,
    EmbedBuilder,
    Message,
    ModalBuilder,
    ModalSubmitInteraction,
    TextChannel,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import path from 'path';
import winston from 'winston';
import env from '@util/env';
import { parseAmount, formatAmount } from './amount';
import { DragSimLookupClient } from './api';
import { evaluateEligibility } from './policy';
import { FileRecruitmentStore } from './store';
import {
    ApplicationRecord,
    LookupClient,
    RecruitmentState,
    RecruitmentStore,
    createDefaultRecruitmentState,
} from './types';

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/;
const CLOSED_SUPPRESSION_MS = 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_APPLICATIONS = 1_000;
const PANEL_EDIT_ID = 'recruitment:panel:edit';
const PANEL_AUTO_ID = 'recruitment:panel:auto';
const PANEL_MODAL_ID = 'recruitment:panel:requirements';
const APPLICATION_PREFIX = 'recruitment:application:';

type RecruitmentInteraction =
    | ChatInputCommandInteraction
    | ButtonInteraction<'cached'>
    | ModalSubmitInteraction<'cached'>;

interface RecruitmentServiceOptions {
    store?: RecruitmentStore;
    lookup?: LookupClient;
    now?: () => number;
    getChannel: () => TextChannel | undefined;
    resolveChannel?: (id: string) => Promise<TextChannel | undefined>;
    isMinecraftReady: () => boolean;
    sendAcceptance: (username: string) => void;
}

interface DecisionResult {
    ok: boolean;
    message: string;
}

function applicationKey(username: string) {
    return username.toLowerCase();
}

function isClosed(application: ApplicationRecord) {
    return application.status !== 'pending';
}

function statusLabel(application: ApplicationRecord) {
    switch (application.status) {
        case 'acceptance-sent':
            return 'Acceptance sent';
        case 'denied':
            return 'Denied locally';
        case 'needs-verification':
            return 'Needs verification';
        case 'accepting':
            return 'Acceptance in flight';
        default:
            return application.lookupStatus === 'pending' ? 'Checking profile' : 'Manual review';
    }
}

export default class RecruitmentService {
    private readonly store: RecruitmentStore;
    private readonly lookup: LookupClient;
    private readonly now: () => number;
    private readonly getChannel: () => TextChannel | undefined;
    private readonly resolveChannel: (id: string) => Promise<TextChannel | undefined>;
    private readonly isMinecraftReady: () => boolean;
    private readonly sendAcceptance: (username: string) => void;
    private state: RecruitmentState;
    private available = true;
    private stopped = false;
    private readonly cardTails = new Map<string, Promise<boolean>>();
    private panelTail: Promise<boolean> = Promise.resolve(false);
    private storageIssue?: string;
    private mutationTail = Promise.resolve();
    private lookupTail = Promise.resolve();
    private readonly deliveryAttempts = new Map<string, number>();
    private readonly deliveryTimers = new Map<string, NodeJS.Timeout>();

    constructor(options: RecruitmentServiceOptions) {
        this.store =
            options.store ??
            new FileRecruitmentStore(path.resolve(env.RECRUITMENT_DATA_DIR, 'recruitment.json'));
        this.lookup = options.lookup ?? new DragSimLookupClient();
        this.now = options.now ?? Date.now;
        this.getChannel = options.getChannel;
        this.resolveChannel =
            options.resolveChannel ??
            (async (id) => {
                const channel = this.getChannel();
                return channel?.id === id ? channel : undefined;
            });
        this.isMinecraftReady = options.isMinecraftReady;
        this.sendAcceptance = options.sendAcceptance;
        try {
            this.state = this.store.load();
            this.recoverInFlightApplications();
        } catch (error) {
            this.state = createDefaultRecruitmentState();
            this.available = false;
            this.storageIssue =
                error instanceof Error ? error.message : 'Recruitment data could not be loaded.';
            winston.error(`Recruitment storage unavailable: ${this.storageIssue}`);
        }
    }

    public get settings() {
        return structuredClone(this.state.settings);
    }

    public get storageError() {
        return this.storageIssue;
    }

    // This is intentionally a pure discriminator used before routing forged component IDs.
    // eslint-disable-next-line class-methods-use-this
    public ownsInteraction(interaction: { customId?: string }) {
        return (
            typeof interaction.customId === 'string' &&
            interaction.customId.startsWith('recruitment:')
        );
    }

    // The fresh Discord member fetch is the authority check; no service state is involved.
    // eslint-disable-next-line class-methods-use-this
    public async authoriseInteraction(interaction: RecruitmentInteraction) {
        if (interaction.guildId !== env.DISCORD_SERVER_ID || !interaction.guild) return false;
        try {
            // Bound the REST check so the interaction can still be acknowledged within 3s.
            let timer: NodeJS.Timeout | undefined;
            const member = await Promise.race([
                interaction.guild.members.fetch({ user: interaction.user.id, force: true }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Role lookup timed out.')), 1500);
                }),
            ]).finally(() => clearTimeout(timer));
            return env.RECRUITMENT_ALLOWED_ROLE_IDS.some((roleId) =>
                member.roles.cache.has(roleId)
            );
        } catch (error) {
            winston.warn('Recruitment role lookup failed:', error);
            return false;
        }
    }

    public async handleJoinRequest(username: string) {
        if (!USERNAME_PATTERN.test(username) || username !== username.trim()) {
            winston.warn('Ignoring a malformed guild join request.');
            return;
        }
        const id = await this.exclusive(async () => {
            this.requireAvailable();
            this.pruneApplications();
            const key = applicationKey(username);
            const existing = this.state.applications.find(
                (application) => application.usernameKey === key && !isClosed(application)
            );
            if (existing) return undefined;
            const recentlyClosed = this.state.applications.find(
                (application) =>
                    application.usernameKey === key &&
                    isClosed(application) &&
                    this.now() - (application.decision?.decidedAt ?? application.receivedAt) <
                        CLOSED_SUPPRESSION_MS
            );
            if (recentlyClosed) return undefined;

            const { settings } = this.state;
            const application: ApplicationRecord = {
                id: randomUUID(),
                username,
                usernameKey: key,
                receivedAt: this.now(),
                status: 'pending',
                lookupStatus: 'pending',
                coverageIssues: [],
                thresholdNetworth: settings.minimumNetworth,
                thresholdPurse: settings.minimumPurse,
                thresholdAutoEnabled: settings.autoAcceptEnabled,
                autoCandidate: false,
                settingsRevision: settings.revision ?? 0,
            };
            if (this.state.applications.length >= MAX_APPLICATIONS)
                throw new Error(
                    'Recruitment review queue is full. Resolve pending applications first.'
                );
            this.state.applications.push(application);
            await this.persist();
            return application.id;
        });
        if (!id) return;
        await this.processApplication(id);
    }

    public async onDiscordReady() {
        await this.mutationTail;
        if (!this.available || this.stopped) return;
        await this.syncPanel(false).catch((error: unknown) => {
            winston.warn('Recruitment settings panel could not be synchronised:', error);
        });
        const applications = this.state.applications.filter(
            (application) =>
                application.status === 'pending' ||
                application.status === 'needs-verification' ||
                application.deliveryIssue
        );
        // Recovery is deliberately sequential to avoid flooding either service.
        // eslint-disable-next-line no-restricted-syntax
        for (const application of applications) {
            if (application.status === 'pending' && application.lookupStatus === 'pending') {
                // Resume interrupted lookups without retroactively auto-accepting old requests.
                application.autoCandidate = false;
                application.settingsRevision = undefined;
                // eslint-disable-next-line no-await-in-loop
                await this.processApplication(application.id);
            } else {
                // eslint-disable-next-line no-await-in-loop
                await this.deliverApplicationCard(application.id);
            }
        }
    }

    public stop() {
        this.stopped = true;
        this.deliveryTimers.forEach((timer) => clearTimeout(timer));
        this.deliveryTimers.clear();
    }

    public async onMinecraftReady() {
        if (!this.available) return;
        const ids = this.state.applications
            .filter((application) => application.status === 'pending' && application.autoCandidate)
            .map((application) => application.id);
        await Promise.all(ids.map((id) => this.tryAutomaticAcceptance(id)));
    }

    public async handleCommand(interaction: ChatInputCommandInteraction) {
        if (!this.available) {
            await interaction.reply({ content: this.unavailableMessage(), ephemeral: true });
            return;
        }
        await interaction.deferReply({});
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'panel') {
            const panel = await this.syncPanel(true, interaction.channelId);
            await interaction.editReply({
                content: panel
                    ? `Open the [recruitment settings panel](https://discord.com/channels/${env.DISCORD_SERVER_ID}/${this.state.settings.panelChannelId}/${this.state.settings.panelMessageId}).`
                    : 'The settings panel could not be delivered yet; the saved settings remain unchanged.',
            });
            return;
        }
        if (subcommand === 'requirements') {
            const networth = interaction.options.getString('networth', true);
            const purse = interaction.options.getString('purse', true);
            try {
                await this.setMinimums(networth, purse);
                await interaction.editReply({ content: this.settingsMessage() });
            } catch (error) {
                await interaction.editReply({
                    content:
                        error instanceof Error ? error.message : 'The minimums were not changed.',
                });
            }
            return;
        }
        if (subcommand === 'auto') {
            const enabled = interaction.options.getBoolean('enabled', true);
            try {
                await this.setAutoEnabled(enabled);
                await interaction.editReply({ content: this.settingsMessage() });
            } catch (error) {
                await interaction.editReply({
                    content:
                        error instanceof Error
                            ? error.message
                            : 'Automatic acceptance was not changed.',
                });
            }
            return;
        }
        await interaction.editReply({ content: this.settingsMessage() });
    }

    public async handleInteraction(
        interaction: ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>
    ) {
        if (!this.available) {
            await this.replyEphemeral(interaction, this.unavailableMessage());
            return;
        }
        if (interaction.isButton()) {
            await this.handleButton(interaction);
            return;
        }
        await this.handleModal(interaction);
    }

    public async setMinimums(networthInput: string, purseInput: string) {
        const minimumNetworth = parseAmount(networthInput);
        const minimumPurse = parseAmount(purseInput);
        await this.exclusive(async () => {
            this.requireAvailable();
            this.state.settings.minimumNetworth = minimumNetworth;
            this.state.settings.minimumPurse = minimumPurse;
            this.state.settings.revision = (this.state.settings.revision ?? 0) + 1;
            this.invalidateAutomaticCandidates();
            if (minimumNetworth === undefined || minimumPurse === undefined) {
                this.state.settings.autoAcceptEnabled = false;
            }
            await this.persist();
        });
        await this.syncPanel(false);
    }

    public async setAutoEnabled(enabled: boolean) {
        await this.exclusive(async () => {
            this.requireAvailable();
            if (
                enabled &&
                (this.state.settings.minimumNetworth === undefined ||
                    this.state.settings.minimumPurse === undefined)
            ) {
                throw new Error(
                    'Set both minimum networth and minimum purse before enabling automatic acceptance.'
                );
            }
            if (this.state.settings.autoAcceptEnabled === enabled) return;
            this.state.settings.autoAcceptEnabled = enabled;
            this.state.settings.revision = (this.state.settings.revision ?? 0) + 1;
            this.invalidateAutomaticCandidates();
            await this.persist();
        });
        await this.syncPanel(false);
    }

    private async processApplication(id: string) {
        if (this.stopped || !this.available) return;
        await this.deliverApplicationCard(id);
        let evidence;
        try {
            evidence = await this.serialLookup(() => {
                this.requireAvailable();
                return this.lookup.lookup(this.application(id)?.username ?? '');
            });
            const currentUsername = this.application(id)?.username;
            if (
                !currentUsername ||
                evidence.username.toLowerCase() !== currentUsername.toLowerCase()
            ) {
                throw new Error('The profile lookup returned a different player identity.');
            }
        } catch (error) {
            await this.exclusive(async () => {
                const application = this.application(id);
                if (!application || application.status !== 'pending') return;
                application.lookupStatus = 'error';
                application.autoCandidate = false;
                application.evaluationReason =
                    error instanceof Error ? error.message : 'The profile lookup failed.';
                application.coverageIssues = [application.evaluationReason];
                await this.persist();
            });
            await this.deliverApplicationCard(id);
            return;
        }

        if (this.stopped || !this.available) return;
        let shouldTryAutomatic = false;
        await this.exclusive(async () => {
            const application = this.application(id);
            if (!application || application.status !== 'pending') return;
            application.lookupStatus = evidence.coverageIssues.length ? 'manual' : 'complete';
            application.playerUuid = evidence.playerUuid;
            application.profileId = evidence.profileId;
            application.profileName = evidence.profileName;
            application.profileSavedAt = evidence.profileSavedAt;
            application.calculatedAt = evidence.calculatedAt;
            application.marketObservedAt = evidence.marketObservedAt;
            application.purse = evidence.purse;
            application.networth = evidence.networth;
            application.partial = evidence.partial;
            application.hidden = evidence.hidden;
            application.unpriced = evidence.unpriced;
            application.uncertainValue = evidence.uncertainValue;
            application.coverageIssues = evidence.coverageIssues;
            application.thresholdNetworth = this.state.settings.minimumNetworth;
            application.thresholdPurse = this.state.settings.minimumPurse;
            application.thresholdAutoEnabled = this.state.settings.autoAcceptEnabled;
            const eligibility = evaluateEligibility(evidence, this.state.settings, this.now());
            const unchanged = application.settingsRevision === (this.state.settings.revision ?? 0);
            application.autoCandidate = eligibility.eligible && unchanged;
            application.evaluationReason = unchanged
                ? eligibility.reason
                : 'Settings changed during this request; manual review required.';
            shouldTryAutomatic = application.autoCandidate;
            await this.persist();
        });
        await this.deliverApplicationCard(id);
        if (shouldTryAutomatic) await this.tryAutomaticAcceptance(id);
    }

    private async tryAutomaticAcceptance(id: string) {
        await this.exclusive(async () => {
            this.requireAvailable();
            const application = this.application(id);
            if (!application || application.status !== 'pending' || !application.autoCandidate)
                return;
            const eligibility = evaluateEligibility(
                {
                    ...application,
                    identityVerified: Boolean(application.playerUuid && application.profileId),
                },
                this.state.settings,
                this.now()
            );
            if (!eligibility.eligible) {
                application.autoCandidate = false;
                application.evaluationReason = eligibility.reason;
                await this.persist();
                return;
            }
            await this.acceptLocked(application, 'automatic-accept');
        });
        await this.deliverApplicationCard(id);
    }

    private async decide(
        id: string,
        kind: 'manual-accept' | 'deny',
        actorId: string
    ): Promise<DecisionResult> {
        const result = await this.exclusive(async () => {
            this.requireAvailable();
            const application = this.application(id);
            if (!application) return { ok: false, message: 'That application no longer exists.' };
            if (application.status !== 'pending')
                return { ok: false, message: 'That application has already been decided.' };
            if (kind === 'deny') {
                application.status = 'denied';
                application.autoCandidate = false;
                application.decision = {
                    kind,
                    actorId,
                    decidedAt: this.now(),
                    note: 'Local denial only; no Minecraft decline command was sent.',
                };
                await this.persist();
                return {
                    ok: true,
                    message:
                        'The application was denied locally. No Minecraft decline command was sent.',
                };
            }
            return this.acceptLocked(application, kind, actorId);
        });
        await this.deliverApplicationCard(id);
        return result;
    }

    // Caller owns the mutation lock through persistence and the synchronous Minecraft send.
    private async acceptLocked(
        application: ApplicationRecord,
        kind: 'manual-accept' | 'automatic-accept',
        actorId?: string
    ): Promise<DecisionResult> {
        if (!this.isMinecraftReady()) {
            application.deliveryIssue =
                'Minecraft is not connected; no acceptance command was sent. Retry when ready.';
            await this.persist();
            return { ok: false, message: application.deliveryIssue };
        }
        application.status = 'accepting';
        application.decision = { kind, actorId, decidedAt: this.now() };
        await this.persist();
        try {
            this.requireAvailable();
            this.sendAcceptance(application.username);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'The command could not be confirmed.';
            if (/not connected|not ready|connected yet|stopped/i.test(message)) {
                application.status = 'pending';
                application.decision = undefined;
                application.deliveryIssue =
                    'Minecraft is disconnected. No acceptance command was sent.';
            } else {
                application.status = 'needs-verification';
                application.autoCandidate = false;
                application.decision.note =
                    'The command may have been sent. Check membership before taking further action.';
            }
            await this.persist();
            return {
                ok: false,
                message:
                    'Acceptance could not be confirmed. Check the application status before retrying.',
            };
        }
        application.status = 'acceptance-sent';
        application.autoCandidate = false;
        application.deliveryIssue = undefined;
        application.decision.note = 'Acceptance sent; server membership has not been confirmed.';
        await this.persist();
        winston.info(`Recruitment acceptance command sent for ${application.username} (${kind}).`);
        return { ok: true, message: 'Acceptance sent. This does not confirm server membership.' };
    }

    private async handleButton(interaction: ButtonInteraction<'cached'>) {
        if (interaction.customId === PANEL_EDIT_ID) {
            if (
                !this.validPanelMessage(interaction.message) ||
                interaction.channelId !== this.state.settings.panelChannelId
            ) {
                await this.replyEphemeral(interaction, 'This settings panel is no longer active.');
                return;
            }
            const modal = new ModalBuilder()
                .setCustomId(PANEL_MODAL_ID)
                .setTitle('Recruitment minimums');
            const networth = new TextInputBuilder()
                .setCustomId('minimum_networth')
                .setLabel('Minimum estimated networth')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(this.state.settings.minimumNetworth?.toString() ?? '');
            const purse = new TextInputBuilder()
                .setCustomId('minimum_purse')
                .setLabel('Minimum purse')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(this.state.settings.minimumPurse?.toString() ?? '');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(networth),
                new ActionRowBuilder<TextInputBuilder>().addComponents(purse)
            );
            await interaction.showModal(modal);
            return;
        }
        if (
            [`${PANEL_AUTO_ID}:enable`, `${PANEL_AUTO_ID}:disable`].includes(interaction.customId)
        ) {
            if (
                !this.validPanelMessage(interaction.message) ||
                interaction.channelId !== this.state.settings.panelChannelId
            ) {
                await this.replyEphemeral(interaction, 'This settings panel is no longer active.');
                return;
            }
            await interaction.deferUpdate();
            try {
                await this.setAutoEnabled(interaction.customId === `${PANEL_AUTO_ID}:enable`);
                await interaction.message.edit(this.panelPayload());
            } catch (error) {
                await interaction.followUp({
                    content:
                        error instanceof Error
                            ? error.message
                            : 'Automatic acceptance was not changed.',
                    ephemeral: true,
                });
            }
            return;
        }
        if (!interaction.customId.startsWith(APPLICATION_PREFIX)) {
            await this.replyEphemeral(interaction, 'That recruitment control is not recognised.');
            return;
        }
        const match = interaction.customId.match(/^recruitment:application:([^:]+):(accept|deny)$/);
        if (!match) {
            await this.replyEphemeral(interaction, 'That recruitment control is not recognised.');
            return;
        }
        const id = match[1];
        if (!id) {
            await this.replyEphemeral(interaction, 'That recruitment control is not recognised.');
            return;
        }
        const application = this.application(id);
        if (
            !application ||
            application.messageId !== interaction.message.id ||
            application.channelId !== interaction.channelId
        ) {
            await this.replyEphemeral(interaction, 'That application card is no longer active.');
            return;
        }
        await interaction.deferUpdate();
        const result = await this.decide(
            id,
            match[2] === 'accept' ? 'manual-accept' : 'deny',
            interaction.user.id
        );
        await interaction.followUp({ content: result.message, ephemeral: true });
    }

    private async handleModal(interaction: ModalSubmitInteraction<'cached'>) {
        if (interaction.customId !== PANEL_MODAL_ID) {
            await this.replyEphemeral(interaction, 'That recruitment form is not recognised.');
            return;
        }
        if (
            !interaction.message ||
            !this.validPanelMessage(interaction.message) ||
            interaction.channelId !== this.state.settings.panelChannelId
        ) {
            await this.replyEphemeral(interaction, 'This settings panel is no longer active.');
            return;
        }
        await interaction.deferReply({ ephemeral: true });
        try {
            await this.setMinimums(
                interaction.fields.getTextInputValue('minimum_networth'),
                interaction.fields.getTextInputValue('minimum_purse')
            );
            await interaction.editReply({ content: this.settingsMessage() });
        } catch (error) {
            await interaction.editReply({
                content: error instanceof Error ? error.message : 'The minimums were not changed.',
            });
        }
    }

    private validPanelMessage(message: Message) {
        return (
            message.id === this.state.settings.panelMessageId &&
            message.channelId === this.state.settings.panelChannelId &&
            message.guildId === env.DISCORD_SERVER_ID
        );
    }

    private panelPayload() {
        const { settings } = this.state;
        const description = [
            `Automatic acceptance: **${settings.autoAcceptEnabled ? 'Enabled' : 'Disabled'}**`,
            `Minimum estimated networth: **${formatAmount(settings.minimumNetworth)}**`,
            `Minimum purse: **${formatAmount(settings.minimumPurse)}**`,
            '',
            'Complete data is required before automatic acceptance. Unknown, private, stale or partial valuations go to manual review.',
        ].join('\n');
        return {
            embeds: [
                new EmbedBuilder()
                    .setColor('Purple')
                    .setTitle('Guild recruitment settings')
                    .setDescription(description),
            ],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(PANEL_EDIT_ID)
                        .setLabel('Edit minimums')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId(
                            `${PANEL_AUTO_ID}:${settings.autoAcceptEnabled ? 'disable' : 'enable'}`
                        )
                        .setLabel(
                            settings.autoAcceptEnabled
                                ? 'Disable auto acceptance'
                                : 'Enable auto acceptance'
                        )
                        .setStyle(
                            settings.autoAcceptEnabled ? ButtonStyle.Danger : ButtonStyle.Success
                        )
                ),
            ],
            allowedMentions: { parse: [] as never[] },
        };
    }

    // Payload construction is kept beside the application interaction handlers.
    // eslint-disable-next-line class-methods-use-this
    private applicationPayload(application: ApplicationRecord) {
        const savedAge = application.profileSavedAt
            ? `<t:${Math.floor(application.profileSavedAt / 1000)}:R>`
            : 'Unknown';
        const values = [
            `Status: **${statusLabel(application)}**`,
            `Estimated networth (includes purse): **${
                application.networth === undefined
                    ? 'Unavailable'
                    : formatAmount(application.networth)
            }**`,
            `Purse: **${
                application.purse === undefined ? 'Unavailable' : formatAmount(application.purse)
            }**`,
            `Profile: **${application.profileName ?? application.profileId ?? 'Unknown'}**`,
            `Profile snapshot saved: **${savedAge}**`,
        ];
        if (application.coverageIssues.length)
            values.push(`Coverage: ${application.coverageIssues.join(' ')}`);
        if (application.evaluationReason) values.push(`Review: ${application.evaluationReason}`);
        if (application.deliveryIssue) values.push(`Notice: ${application.deliveryIssue}`);
        if (application.decision?.note) values.push(application.decision.note);
        let color: 'Red' | 'Green' | 'Purple' = 'Purple';
        if (application.status === 'denied') color = 'Red';
        else if (application.status === 'acceptance-sent') color = 'Green';
        return {
            embeds: [
                new EmbedBuilder()
                    .setColor(color)
                    .setTitle(`Guild application: ${application.username}`)
                    .setDescription(values.join('\n'))
                    .setTimestamp(new Date(application.receivedAt)),
            ],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`${APPLICATION_PREFIX}${application.id}:accept`)
                        .setLabel('Accept')
                        .setStyle(ButtonStyle.Success)
                        .setDisabled(application.status !== 'pending'),
                    new ButtonBuilder()
                        .setCustomId(`${APPLICATION_PREFIX}${application.id}:deny`)
                        .setLabel('Deny')
                        .setStyle(ButtonStyle.Danger)
                        .setDisabled(application.status !== 'pending')
                ),
            ],
            allowedMentions: { parse: [] as never[] },
        };
    }

    private syncPanel(createIfMissing: boolean, channelId?: string): Promise<boolean> {
        this.panelTail = this.panelTail
            .catch(() => false)
            .then(() => this.syncPanelNow(createIfMissing, channelId));
        return this.panelTail;
    }

    private async syncPanelNow(createIfMissing: boolean, channelId?: string) {
        if (this.stopped || !this.available) return false;
        const targetChannelId =
            channelId ?? this.state.settings.panelChannelId ?? env.MEMBER_CHANNEL_ID;
        const channel = await this.resolveChannel(targetChannelId);
        if (
            !channel ||
            channel.id !== targetChannelId ||
            channel.guildId !== env.DISCORD_SERVER_ID
        ) {
            throw new Error(
                'Use this command in a text channel in this Discord server where the bot can view, send and embed messages.'
            );
        }
        const existingId = this.state.settings.panelMessageId;
        if (existingId && this.state.settings.panelChannelId === channel.id) {
            try {
                const message = await channel.messages.fetch(existingId);
                if (message.channelId !== channel.id || message.guildId !== env.DISCORD_SERVER_ID)
                    return false;
                await message.edit(this.panelPayload());
                return true;
            } catch (error) {
                if (!createIfMissing) {
                    winston.warn('Saved recruitment panel message could not be updated:', error);
                    return false;
                }
            }
        }
        if (!createIfMissing) return false;
        const previousPanelChannelId = this.state.settings.panelChannelId;
        const message = await channel.send(this.panelPayload());
        await this.exclusive(async () => {
            this.state.settings.panelMessageId = message.id;
            this.state.settings.panelChannelId = channel.id;
            await this.persist();
        });
        if (existingId && previousPanelChannelId && previousPanelChannelId !== channel.id) {
            try {
                const oldChannel = await this.resolveChannel(previousPanelChannelId);
                const oldMessage = await oldChannel?.messages.fetch(existingId);
                await oldMessage?.edit({
                    embeds: [
                        new EmbedBuilder()
                            .setColor('Grey')
                            .setTitle('Recruitment panel moved')
                            .setDescription(
                                `Use the [current settings panel](https://discord.com/channels/${env.DISCORD_SERVER_ID}/${channel.id}/${message.id}).`
                            ),
                    ],
                    components: [],
                    allowedMentions: { parse: [] },
                });
            } catch {
                winston.warn(
                    'The old recruitment panel could not be marked as moved. Its controls are inactive.'
                );
            }
        }
        return true;
    }

    private deliverApplicationCard(id: string): Promise<boolean> {
        const previous = this.cardTails.get(id) ?? Promise.resolve(false);
        const pending = previous.catch(() => false).then(() => this.deliverApplicationCardNow(id));
        this.cardTails.set(id, pending);
        pending
            .finally(() => {
                if (this.cardTails.get(id) === pending) this.cardTails.delete(id);
            })
            .catch(() => undefined);
        return pending;
    }

    private async deliverApplicationCardNow(id: string) {
        if (this.stopped || !this.available) return false;
        const application = this.application(id);
        const targetChannelId =
            application?.channelId ?? (env.RECRUITMENT_CHANNEL_ID || env.MEMBER_CHANNEL_ID);
        let channel: TextChannel | undefined;
        try {
            channel = await this.resolveChannel(targetChannelId);
        } catch {
            this.scheduleDeliveryRetry(id);
            return false;
        }
        if (
            !application ||
            !channel ||
            channel.id !== targetChannelId ||
            channel.guildId !== env.DISCORD_SERVER_ID
        ) {
            this.scheduleDeliveryRetry(id);
            return false;
        }
        const payload = this.applicationPayload(application);
        try {
            if (application.messageId && application.channelId === channel.id) {
                let message;
                try {
                    message = await channel.messages.fetch(application.messageId);
                } catch (error) {
                    if ((error as { code?: number }).code !== 10008) throw error;
                    await this.exclusive(async () => {
                        const current = this.application(id);
                        if (current) {
                            current.messageId = undefined;
                            current.channelId = undefined;
                            await this.persist();
                        }
                    });
                    this.scheduleDeliveryRetry(id);
                    return false;
                }
                if (message.channelId !== channel.id || message.guildId !== env.DISCORD_SERVER_ID)
                    throw new Error('Application message is outside its recruitment channel.');
                await message.edit(payload);
            } else if (!application.messageId) {
                const message = await channel.send(payload);
                await this.exclusive(async () => {
                    const current = this.application(id);
                    if (!current || current.messageId) return;
                    current.channelId = channel.id;
                    current.messageId = message.id;
                    current.deliveryIssue = undefined;
                    await this.persist();
                });
            } else {
                throw new Error(
                    'Application card channel did not match its stored recruitment channel.'
                );
            }
            this.deliveryAttempts.delete(id);
            clearTimeout(this.deliveryTimers.get(id));
            this.deliveryTimers.delete(id);
            return true;
        } catch (error) {
            await this.exclusive(async () => {
                const current = this.application(id);
                if (!current) return;
                current.deliveryIssue =
                    error instanceof Error
                        ? error.message
                        : 'The application card could not be delivered.';
                await this.persist();
            }).catch(() => undefined);
            this.scheduleDeliveryRetry(id);
            return false;
        }
    }

    private scheduleDeliveryRetry(id: string) {
        if (this.stopped || !this.available || this.deliveryTimers.has(id)) return;
        const attempt = this.deliveryAttempts.get(id) ?? 0;
        if (attempt >= 4) return;
        const delays = [1_000, 5_000, 30_000, 300_000];
        this.deliveryAttempts.set(id, attempt + 1);
        const timer = setTimeout(() => {
            this.deliveryTimers.delete(id);
            this.deliverApplicationCard(id).catch((error: unknown) =>
                winston.warn('Recruitment card retry failed:', error)
            );
        }, delays[attempt]);
        this.deliveryTimers.set(id, timer);
    }

    private application(id: string) {
        return this.state.applications.find((application) => application.id === id);
    }

    private pruneApplications() {
        const cutoff = this.now() - RETENTION_MS;
        const closed = this.state.applications.filter(
            (application) =>
                isClosed(application) &&
                (application.decision?.decidedAt ?? application.receivedAt) < cutoff
        );
        if (closed.length || this.state.applications.length >= MAX_APPLICATIONS) {
            const active = this.state.applications.filter((application) => !isClosed(application));
            const retainedClosed = this.state.applications
                .filter((application) => isClosed(application))
                .filter(
                    (application) =>
                        (application.decision?.decidedAt ?? application.receivedAt) >= cutoff
                )
                .sort((a, b) => b.receivedAt - a.receivedAt)
                .slice(0, Math.max(0, MAX_APPLICATIONS - active.length - 1));
            this.state.applications = [...active, ...retainedClosed];
        }
    }

    private invalidateAutomaticCandidates() {
        this.state.applications.forEach((application) => {
            if (application.status === 'pending') application.autoCandidate = false;
        });
    }

    private recoverInFlightApplications() {
        let changed = false;
        this.state.applications.forEach((application) => {
            if (application.status !== 'accepting') return;
            application.status = 'needs-verification';
            application.autoCandidate = false;
            application.decision = {
                kind: application.decision?.kind ?? 'manual-accept',
                actorId: application.decision?.actorId,
                decidedAt: application.decision?.decidedAt ?? this.now(),
                note: 'Recovered after an uncertain acceptance attempt. Verify the server before retrying.',
            };
            changed = true;
        });
        if (changed) {
            this.mutationTail = this.store.save(this.state).catch((error: unknown) => {
                this.available = false;
                this.storageIssue =
                    error instanceof Error
                        ? error.message
                        : 'Recovered recruitment data could not be saved.';
            });
        }
    }

    private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.mutationTail;
        let release!: () => void;
        this.mutationTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private async serialLookup<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.lookupTail;
        let release!: () => void;
        this.lookupTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private async persist() {
        try {
            await this.store.save(this.state);
        } catch (error) {
            this.available = false;
            this.storageIssue =
                error instanceof Error ? error.message : 'Recruitment data could not be saved.';
            throw error;
        }
    }

    private requireAvailable() {
        if (this.stopped) throw new Error('Recruitment is stopped.');
        if (!this.available) throw new Error(this.unavailableMessage());
    }

    private unavailableMessage() {
        return `Recruitment storage is unavailable${
            this.storageIssue ? `: ${this.storageIssue}` : '.'
        } Automatic and manual decisions are disabled.`;
    }

    private settingsMessage() {
        const { settings } = this.state;
        return `Automatic acceptance: ${
            settings.autoAcceptEnabled ? 'enabled' : 'disabled'
        }; minimum networth: ${formatAmount(
            settings.minimumNetworth
        )}; minimum purse: ${formatAmount(settings.minimumPurse)}.`;
    }

    // This helper only normalises Discord's reply/edit response pair.
    // eslint-disable-next-line class-methods-use-this
    private async replyEphemeral(
        interaction: ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>,
        content: string
    ) {
        if (interaction.replied || interaction.deferred) await interaction.editReply({ content });
        else await interaction.reply({ content, ephemeral: true });
    }
}
