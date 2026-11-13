import { EmbedBuilder, EmbedFooterOptions } from 'discord.js';

export const BRIDGE_CREDIT = 'Created & maintained by @LabGeek';

/** Shared presentation for every bridge embed, including replies and card updates. */
export default class BridgeEmbed extends EmbedBuilder {
    constructor() {
        super();
        this.setFooter(null);
    }

    public override setFooter(options: EmbedFooterOptions | null) {
        const text = options?.text;
        return super.setFooter({
            ...options,
            text:
                text && !text.endsWith(BRIDGE_CREDIT)
                    ? `${text}\n${BRIDGE_CREDIT}`
                    : text || BRIDGE_CREDIT,
        });
    }
}
