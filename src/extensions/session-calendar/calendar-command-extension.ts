import { BaseInteractionExtension } from "../extension-interface";
import {

    serverIdStateMap,
    CalendarExtensionState
} from './calendar-states';
import { ButtonInteraction, CommandInteraction, Guild } from 'discord.js';
import { SlashCommandBuilder } from "@discordjs/builders";
import { EmbedColor, ErrorEmbed, SimpleEmbed } from "../../utils/embed-helper";
import {
    CommandNotImplementedError,
    CommandParseError,
    UserViewableError
} from "../../utils/error-types";
import { CommandData } from '../../command-handling/slash-commands';
import {
    hasValidQueueArgument,
    isTriggeredByUserWithRoles
} from '../../command-handling/common-validations';
import {
    buildCalendarURL,
    getUpComingTutoringEvents,
} from './shared-calendar-functions';
import { calendar_v3 } from "googleapis";
import { FgCyan, ResetColor } from "../../utils/command-line-colors";

import calendarConfig from '../extension-credentials/calendar-config.json';


const setCalendar = new SlashCommandBuilder()
    .setName("set_calendar")
    .setDescription(
        "Commands to modify the resources connected to the /when_next command"
    )
    .addStringOption((option) =>
        option
            .setName("calendar_id")
            .setDescription("The link to the calendar")
            .setRequired(true)
    );

const whenNext = new SlashCommandBuilder()
    .setName("when_next")
    .setDescription("View the upcoming tutoring hours")
    .addChannelOption((option) =>
        option
            .setName("queue_name")
            .setDescription(
                "The course for which you want to view the next tutoring hours"
            )
            .setRequired(false)
    );

function makeCalendarStringCommand():
    Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup"> {
    const command = new SlashCommandBuilder()
        .setName("make_calendar_string")
        .setDescription("Generates a valid calendar string that can be parsed by YABOB")
        .addStringOption(option => option
            .setRequired(true)
            .setName('your_name')
            .setDescription("Your display name on the calendar"));

    Array(20).forEach((_, idx) =>
        command.addChannelOption(option =>
            option.setName(`queue_name_${idx + 1}`)
                .setDescription(
                    "The courses you tutor for"
                )
                .setRequired(idx === 0)) // make the first one required
    );
    return command;
}

class CalendarConnectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CalendarConnectionError";
    }
    briefErrorString(): string {
        return `**${this.name}**: ${this.message}`;
    }
}

class CalendarInteractionExtension extends BaseInteractionExtension {

    protected constructor(private readonly guild: Guild) {
        super();
    }

    static async load(guild: Guild): Promise<CalendarInteractionExtension> {
        serverIdStateMap.set(
            guild.id,
            await CalendarExtensionState.load(guild.id, guild.name)
        );
        return new CalendarInteractionExtension(guild);
    }

    // I know this is very verbose but TS gets angry if I don't write all this :(
    public override commandMethodMap: ReadonlyMap<
        string,
        (interaction: CommandInteraction) => Promise<string | void>
    > = new Map<string, (interaction: CommandInteraction) => Promise<string | void>>([
        ['set_calendar', (interaction: CommandInteraction) =>
            this.updateCalendarId(interaction)],
        ['when_next', (interaction: CommandInteraction) =>
            this.listUpComingHours(interaction)],
        ['make_calendar_string', (interaction: CommandInteraction) =>
            this.makeParsableCalendarTitle(interaction)]
    ]);

    public override buttonMethodMap: ReadonlyMap<
        string,
        (interaction: ButtonInteraction, queueName: string) => Promise<string | void>
    > = new Map([
        ['refresh', (_: ButtonInteraction, queueName: string) =>
            this.requestCalendarRefresh(queueName)]
    ]);

    override get slashCommandData(): CommandData {
        return [
            setCalendar.toJSON(),
            whenNext.toJSON(),
            makeCalendarStringCommand().toJSON()
        ];
    }

    /**
     * Button handler. Almost the same as the built in command-handler.ts
    */
    override async processCommand(interaction: CommandInteraction): Promise<void> {
        await interaction.reply({
            ...SimpleEmbed(
                'Processing command...',
                EmbedColor.Neutral
            ),
            ephemeral: true
        });
        const commandMethod = this.commandMethodMap.get(interaction.commandName);
        if (commandMethod === undefined) {
            await interaction.editReply(ErrorEmbed(
                new CommandNotImplementedError('This external command does not exist.')
            ));
            return;
        }
        console.log(
            `[${FgCyan}${(new Date).toLocaleString()}${ResetColor}]` +
            ` User ${interaction.user.username}` +
            ` used ${interaction.toString()}`
        );
        await commandMethod(interaction)
            // if the method didn't directly reply, the center handler replies
            .then(async successMsg => successMsg &&
                await interaction.editReply(
                    SimpleEmbed(
                        successMsg,
                        EmbedColor.Success)
                ))
            .catch(async (err: UserViewableError) =>
                await interaction.editReply(
                    ErrorEmbed(err)
                ));
    }

    /**
     * Button handler. Almost the same as the built in button-handler.ts
    */
    override async processButton(interaction: ButtonInteraction): Promise<void> {
        await interaction.reply({
            ...SimpleEmbed(
                'Processing button...',
                EmbedColor.Neutral
            ),
            ephemeral: true
        });

        const delimiterPosition = interaction.customId.indexOf(" ");
        const interactionName = interaction.customId.substring(0, delimiterPosition);
        const queueName = interaction.customId.substring(delimiterPosition + 1);
        const buttonMethod = this.buttonMethodMap.get(interactionName);

        if (buttonMethod === undefined) {
            await interaction.editReply(ErrorEmbed(
                new CommandNotImplementedError('This external command does not exist.')
            ));
            return;
        }

        console.log(
            `[${FgCyan}${(new Date).toLocaleString()}${ResetColor}] ` +
            `User ${interaction.user.username} ` +
            `pressed [${interaction.customId}] `
        );

        await buttonMethod(interaction, queueName)
            // if the method didn't directly reply, the center handler replies
            .then(async successMsg => successMsg &&
                await interaction.editReply(
                    SimpleEmbed(
                        successMsg,
                        EmbedColor.Success)
                ))
            .catch(async (err: UserViewableError) =>
                await interaction.editReply(
                    ErrorEmbed(err)
                ));
    }

    private async updateCalendarId(interaction: CommandInteraction): Promise<string> {
        const newCalendarId = interaction.options.getString('calendar_id', true);
        const [newCalendarName] = await Promise.all([
            this.checkCalendarConnection(
                newCalendarId
            ).catch(() => Promise.reject(
                new CalendarConnectionError('This new calendar ID is not valid.')
            )),
            isTriggeredByUserWithRoles(
                interaction,
                "set_calendar",
                ['Bot Admin']
            )
        ]);

        // runtime only. Will be resetted when YABOB restarts
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await serverIdStateMap.get(this.guild.id)?.setCalendarId(newCalendarId);
        await Promise.all(
            serverIdStateMap
                .get(this.guild.id)
                ?.listeners
                .map(listener => listener.onCalendarExtensionStateChange()) ?? []
        );

        return Promise.resolve(
            `Successfully changed to new calendar` +
            ` ${newCalendarName.length > 0
                ? ` '${newCalendarName}'. `
                : ", but it doesn't have a name. "}` +
            `The calendar embed will refresh soon. ` +
            `Or you can manually refresh it using the refresh button.`
        );
    }

    private async listUpComingHours(interaction: CommandInteraction): Promise<void> {
        const channel = await hasValidQueueArgument(interaction);
        const viewModels = await getUpComingTutoringEvents(
            this.guild.id,
            channel.queueName
        );

        const embed = SimpleEmbed(
            `Upcoming Hours for ${channel.queueName}`,
            EmbedColor.NoColor,
            viewModels.length > 0
                ? viewModels
                    .map(viewModel =>
                        `**${viewModel.discordId !== undefined
                            ? `<@${viewModel.discordId}>`
                            : viewModel.displayName
                        }**\t|\t` +
                        `Start: <t:${viewModel.start.getTime().toString().slice(0, -3)}:R>\t|\t` +
                        `End: <t:${viewModel.end.getTime().toString().slice(0, -3)}:R>`)
                    .join('\n')
                : `There are no upcoming sessions for ${channel.queueName} in the next 7 days.`
        );

        await interaction.editReply(embed);
    }

    /**
     * Makes calendar titles with every queue arg optional
     * ----
    */
    private async makeParsableCalendarTitle(interaction: CommandInteraction): Promise<string> {
        // all the queue_name_1, queue_name_2, ... 
        await isTriggeredByUserWithRoles(
            interaction,
            "make_calendar_string",
            ['Bot Admin', 'Staff']
        );

        const calendarDisplayName = interaction.options.getString('your_name', true);

        const commandArgs = [...this.guild.channels.cache
            .filter(channel => channel.type === 'GUILD_CATEGORY')]
            .map((_, idx) => interaction.options
                .getChannel(`queue_name_${idx + 1}`, idx === 0))
            .filter(queueArg => queueArg !== undefined && queueArg !== null);

        const validQueues = await Promise.all(commandArgs.map(category => {
            if (category?.type !== 'GUILD_CATEGORY' || category === null) {
                return Promise.reject(new CommandParseError(
                    `\`${category?.name}\` is not a valid queue category.`
                ));
            }
            const queueTextChannel = category.children
                .find(child =>
                    child.name === 'queue' &&
                    child.type === 'GUILD_TEXT');
            if (queueTextChannel === undefined) {
                return Promise.reject(new CommandParseError(
                    `'${category.name}' does not have a \`#queue\` text channel.`
                ));
            }
            return Promise.resolve(category);
        }));

        await serverIdStateMap
            .get(this.guild.id)
            ?.updateNameDiscordIdMap(
                calendarDisplayName,
                interaction.user.id
            );

        await Promise.all(serverIdStateMap.get(this.guild.id)?.listeners
            .map(listener => listener.onCalendarExtensionStateChange()) ?? []);

        return Promise.resolve(
            `${calendarDisplayName} - ` +
            `${validQueues.map(queue => queue.name).join(', ')}`
        );
    }

    private async checkCalendarConnection(
        newCalendarId: string
    ): Promise<string> {
        const nextWeek = new Date();
        nextWeek.setDate(nextWeek.getDate() + 7);
        const url = buildCalendarURL({
            calendarId: newCalendarId,
            timeMin: new Date(),
            timeMax: nextWeek,
            apiKey: calendarConfig.YABOB_GOOGLE_API_KEY
        });

        const response = await fetch(url);
        if (response.status !== 200) {
            return Promise.reject('Calendar request failed.');
        }
        const responseJSON = await response.json();
        return (responseJSON as calendar_v3.Schema$Events).summary ?? '';
    }

    private async requestCalendarRefresh(queueName: string): Promise<string> {
        await serverIdStateMap
            .get(this.guild.id)
            ?.listeners
            .get(queueName)
            ?.onCalendarExtensionStateChange();
        return `Successfully refreshed upcoming hours for ${queueName}`;
    }
}


export { CalendarInteractionExtension, CalendarConnectionError };