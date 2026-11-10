import { Client, Collection, EmbedBuilder, TextChannel } from 'discord.js';
import recursiveWalkDir from '@util/recursive-walk-dir';
import path from 'path';
import loadEvents from '@util/load-events';
import loadModule from '@util/load-module';
import Bridge from '../bridge';

export default class Discord extends Client {
    public readonly commands: Collection<string, Command> = new Collection();
    public memberChannel?: TextChannel;

    public async send(content: string) {
        if (!this.memberChannel) throw new Error('The Discord bridge channel is not ready.');
        const embed = new EmbedBuilder().setDescription(content).setColor(0x8e44ad);
        await this.memberChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    public async loadCommands() {
        await recursiveWalkDir(
            path.join(__dirname, 'commands/'),
            async (currentDir, file) => {
                if (!(file.endsWith('.ts') || file.endsWith('.js')) || file.endsWith('.d.ts'))
                    return;
                const command = loadModule<Command>(path.join(currentDir, file));
                if (!command.data || !command.run) throw new Error(`Invalid command: ${file}`);
                this.commands.set(command.data.name, command);
            },
            'Error while loading commands:'
        );
    }

    public async loadEvents(bridge: Bridge) {
        await loadEvents(path.join(__dirname, 'events/'), this, bridge);
    }
}
