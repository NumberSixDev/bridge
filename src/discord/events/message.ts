import { Message } from 'discord.js';
import { DataSet, RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity';
import emojis from '@util/emojis';
import env from '@util/env';
import { formatGuildMessage } from '@util/guild-chat';

const whitelist = ['ass', 'bitch', 'cock', 'dick', 'fuck'];
const dataset = new DataSet<{ originalWord: string }>()
    .addAll(englishDataset)
    .removePhrasesIf((phrase) => whitelist.includes(phrase.metadata!.originalWord));
const profanityMatcher = env.USE_PROFANITY_FILTER
    ? new RegExpMatcher({ ...dataset.build(), ...englishRecommendedTransformers })
    : null;

export default {
    name: 'messageCreate',
    runOnce: false,
    run: async (bridge, message: Message) => {
        if (
            message.guildId !== env.DISCORD_SERVER_ID ||
            message.channelId !== env.MEMBER_CHANNEL_ID ||
            message.author.bot ||
            message.webhookId ||
            message.content.startsWith(env.DISCORD_IGNORE_PREFIX) ||
            !message.content.trim() ||
            !message.member
        )
            return;
        const name = env.USE_FIRST_WORD_OF_AUTHOR_NAME
            ? message.member.displayName.split(' ')[0]!
            : message.member.displayName;
        try {
            if (profanityMatcher?.hasMatch(message.content)) {
                throw new Error('That message was not relayed because it matched the chat filter.');
            }
            bridge.mineflayer.chat(
                formatGuildMessage(name, message.cleanContent, env.MINECRAFT_CHAT_SEPARATOR)
            );
        } catch (error) {
            await message.reply({
                content: `${emojis.warning} ${
                    error instanceof Error ? error.message : 'The message could not be relayed.'
                }`,
                allowedMentions: { parse: [], repliedUser: false },
            });
        }
    },
} as BotEvent;
