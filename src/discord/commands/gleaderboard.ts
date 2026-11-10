import { ApplicationCommandOptionType } from 'discord.js';

const categories = [
    ['networth', 'Rank current guild members by estimated networth.'],
    ['purse', 'Rank current guild members by purse coins.'],
    ['collections', 'Rank collection counts or a selected collection.'],
    ['skills', 'Rank total skills XP or a selected skill.'],
    ['bestiary', 'Rank bestiary kills or a selected mob.'],
    ['slayer', 'Rank slayer XP, levels or a selected slayer stat.'],
    ['dungeons', 'Rank dungeon completions or a selected dungeon stat.'],
    ['mining', 'Rank Heart of the Dragon progress or a selected node.'],
    ['currencies', 'Rank a public currency or progression counter.'],
    ['stats', 'Rank a public base or modifier stat.'],
    ['rng', 'Rank RNG meter kills or a selected meter.'],
] as const;

export default {
    data: {
        name: 'gleaderboard',
        description: 'Rank current Minecraft guild members by public player stats.',
        options: categories.map(([name, description]) => ({
            name,
            description,
            type: ApplicationCommandOptionType.Subcommand,
            options:
                name === 'networth' || name === 'purse'
                    ? undefined
                    : [
                          {
                              name: 'stat',
                              description:
                                  'Choose a specific stat or leave blank for the category total.',
                              type: ApplicationCommandOptionType.String,
                              required: false,
                              autocomplete: true,
                          },
                      ],
        })),
    },
    run: async (bridge, interaction) => bridge.leaderboard.handleCommand(interaction),
} as Command;
