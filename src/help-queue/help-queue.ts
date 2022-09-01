import { GuildMember, Role, TextChannel, User, Collection } from 'discord.js';
import { QueueChannel } from '../attending-server/base-attending-server';
import { CalendarExtension } from '../extensions/calendar-extension';
import { IQueueExtension } from '../extensions/extension-interface';
import { QueueBackup } from '../extensions/firebase-models/backups';
import { Helper, Helpee } from '../models/member-states';
import { EmbedColor, SimpleEmbed } from '../utils/embed-helper';
import { QueueError, QueueRenderError } from '../utils/error-types';
import { QueueDisplayV2 } from './queue-display';

type QueueViewModel = {
    name: string;
    helperIDs: Array<string>;
    studentDisplayNames: Array<string>;
    calendarString?: string;
    isOpen: boolean;
}

class HelpQueueV2 {

    // Key is Guildmember.id
    private helpers: Collection<string, Helper> = new Collection();
    private students: Helpee[] = [];

    // Key is Guildmember.id
    private notifGroup: Collection<string, GuildMember> = new Collection();
    private isOpen = false;
    private readonly display: QueueDisplayV2;

    public intervalID?: NodeJS.Timer;

    /**
     * @param user YABOB's user object for QueueDisplay
     * @param queueChannel the channel to manage
     * @param queueExtensions individual queue extensions to inject
     * @param backupData If defined, use this data to restore the students array
    */
    protected constructor(
        user: User,
        private queueChannel: QueueChannel,
        private queueExtensions: IQueueExtension[],
        backupData?: QueueBackup
    ) {
        this.display = new QueueDisplayV2(user, queueChannel);
        // If we choose to use backup,
        // restore members with queueChannel.channelObj.members.get()
        if (backupData !== undefined) {
            backupData.studentsInQueue.forEach(studentBackup => {
                // forEach backup, if there's a corresponding channel member, push it into queue
                const correspondingMember = this.queueChannel.channelObj.members
                    .get(studentBackup.memberId);
                if (correspondingMember !== undefined) {
                    this.students.push({
                        waitStart: studentBackup.waitStart,
                        upNext: studentBackup.upNext,
                        member: correspondingMember
                    });
                }
            });
        }
    }

    get length(): number { // number of students
        return this.students.length;
    }
    get currentlyOpen(): boolean { // is the queue open
        return this.isOpen;
    }
    get name(): string { // name of corresponding class
        return this.queueChannel.queueName;
    }
    get channelObj(): Readonly<TextChannel> { // #queue text channel object
        return this.queueChannel.channelObj;
    }
    get parentCategoryId(): string {
        return this.queueChannel.parentCategoryId;
    }
    get first(): Helpee | undefined { // first student; undefined if no one is here
        return this.students[0];
    }
    get studentsInQueue(): ReadonlyArray<Required<Helpee>> {
        return this.students;
    }
    get currentHelpers(): ReadonlyArray<Helper> {
        return [...this.helpers.values()];
    }
    get helperIDs(): ReadonlySet<string> { // set of helper IDs. Use this only for lookup
        return new Set(this.helpers.keys());
    }

    /**
     * Asynchronously creates a clean queue
     * ----
     * @param queueChannel the corresponding text channel and its name
     * @param user YABOB's client object. Used for queue rendering
     * @param everyoneRole used for locking the queue
     * @param backupData backup queue data directly passed to the constructor
    */
    static async create(
        queueChannel: QueueChannel,
        user: User,
        everyoneRole: Role,
        backupData?: QueueBackup
    ): Promise<HelpQueueV2> {
        // * Load QueueExtensions here
        const queueExtensions = await Promise.all([
            CalendarExtension.load(
                1, // renderIndex
                queueChannel.queueName,
                process.env.YABOB_GOOGLE_CALENDAR_ID
            )
        ]);

        const queue = new HelpQueueV2(
            user,
            queueChannel,
            queueExtensions,
            backupData
        );

        queue.intervalID = setInterval(async () => {
            await Promise.all(queueExtensions.map(
                extension => extension.onQueuePeriodicUpdate(queue)
            )); // Random offset to avoid spamming the APIs
        }, (1000 * 60 * 60 * 24) + Math.floor(Math.random() * 2000));

        // This need to happen first
        // because extensions need to rerender in cleanUpQueueChannel()
        await Promise.all(
            queueExtensions.map(extension => extension.onQueuePeriodicUpdate(queue))
        );
        await queue.cleanUpQueueChannel();
        await queueChannel.channelObj.permissionOverwrites.create(
            everyoneRole,
            {
                SEND_MESSAGES: false,
                CREATE_PRIVATE_THREADS: false,
                CREATE_PUBLIC_THREADS: false,
                ADD_REACTIONS: false
            }
        );
        await queueChannel.channelObj.permissionOverwrites.create(
            user,
            { SEND_MESSAGES: true });
        return queue;
    }

    /**
     * Open a queue with a helper
     * ----
     * @param helperMember member with Staff/Admin that used /start
     * @param notify notify everyone in the notif group
     * @throws QueueError: do nothing if helperMemeber is already helping
    */
    async openQueue(helperMember: GuildMember, notify: boolean): Promise<void> {
        if (this.helpers.has(helperMember.id)) {
            return Promise.reject(new QueueError(
                'Queue is already open',
                this.name));
        } // won't actually be seen, will be caught

        const helper: Helper = {
            helpStart: new Date(),
            helpedMembers: [],
            member: helperMember
        };
        this.isOpen = true;
        this.helpers.set(helperMember.id, helper);

        await Promise.all([
            notify && // shorthand syntax, the RHS of && will be invoked if LHS is true
            this.notifGroup.map(notifMember => notifMember.send(
                SimpleEmbed(`Queue \`${this.name}\` is open!`)
            )),
            this.queueExtensions.map(extension => extension.onQueueOpen(this))
        ]);
        await this.triggerRender();
    }

    /**
     * Close a queue with a helper
     * ----
     * @param helperMember member with Staff/Admin that used /stop
     * @throws QueueError: do nothing if queue is closed
    */
    async closeQueue(helperMember: GuildMember): Promise<Required<Helper>> {
        const helper = this.helpers.get(helperMember.id);
        // These will be caught and show 'You are not currently helping'
        if (!this.isOpen) {
            return Promise.reject(new QueueError(
                'Queue is already closed',
                this.name));
        }
        if (!helper) {
            return Promise.reject(new QueueError(
                'You are not one of the helpers',
                this.name));
        }

        this.helpers.delete(helperMember.id);
        this.isOpen = this.helpers.size > 0;
        helper.helpEnd = new Date();

        await Promise.all(this.queueExtensions.map(
            extension => extension.onQueueClose(this))
        );
        await this.triggerRender();
        return helper as Required<Helper>;
    }

    /**
     * Enqueue a student
     * @param studentMember the complete Helpee object
     * @throws QueueError: 
    */
    async enqueue(studentMember: GuildMember): Promise<void> {
        if (!this.isOpen) {
            return Promise.reject(new QueueError(
                `Queue is not open.`,
                this.name));
        }
        if (this.students
            .find(s => s.member.id === studentMember.id) !== undefined) {
            return Promise.reject(new QueueError(
                `You are already in the queue.`,
                this.name
            ));
        }
        if (this.helpers.has(studentMember.id)) {
            return Promise.reject(new QueueError(
                `You can't enqueue yourself while helping.`,
                this.name
            ));
        }

        const student: Helpee = {
            waitStart: new Date(),
            upNext: this.students.length === 0,
            member: studentMember
        };
        this.students.push(student);

        // the Promise<void> cast is for combining 2 different promise types
        // so that they can be launched in parallel
        // we won't use the return values so it's safe to cast
        await Promise.all([
            this.helpers.map(helper =>
                helper.member.send(SimpleEmbed(
                    `Heads up! ${student.member.displayName} has joined "${this.name}".`,
                    EmbedColor.Neutral,
                    `<@${student.member.user.id}>`))
            ),
            this.queueExtensions.map(extension => extension.onEnqueue(student))
        ].flat() as Promise<void>[]);
        await this.triggerRender();
    }

    /**
     * Dequeue this particular queue with a helper
     * ----
     * @param helperMember the member that triggered dequeue
     * @throws QueueError when
     * - Queue is not open
     * - No student is here
     * - helperMember is not one of the helpers
    */
    async dequeueWithHelper(helperMember: GuildMember): Promise<Readonly<Helpee>> {
        const helper = this.helpers.get(helperMember.id);
        if (!this.isOpen) {
            return Promise.reject(new QueueError(
                'This queue is not open. Did you mean to use `/start`?',
                this.name));
        }
        if (this.students.length === 0) {
            return Promise.reject(new QueueError(
                'There\'s no one in the queue',
                this.name));
        }
        if (!helper) {
            return Promise.reject(new QueueError(
                'You don\'t have permission to help this queue',
                this.name));
        }
        // assertion is safe becasue we already checked for length
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const firstStudent = this.students.shift()!;
        helper.helpedMembers.push(firstStudent.member);
        await Promise.all(this.queueExtensions.map(
            extension => extension.onDequeue(firstStudent))
        );
        await this.triggerRender();
        return firstStudent;
    }

    /**
     * Remove a student from the queue. Used for /leave
     * ----
     * @param targetStudent the student to remove
     * @throws QueueError: the student is not in the queue
    */
    async removeStudent(targetStudent: GuildMember): Promise<void> {
        const idx = this.students
            .findIndex(student => student.member.id === targetStudent.id);
        if (idx === -1) {
            return Promise.reject(new QueueError(
                `${targetStudent.displayName} is not in the queue`,
                this.name
            ));
        }
        // we checked for idx === -1, so it will not be null
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const removedStudent = this.students[idx]!;
        this.students.splice(idx, 1);
        await Promise.all(this.queueExtensions.map(
            extension => extension.onStudentRemove(removedStudent))
        );
        await this.triggerRender();
    }

    /**
     * Remove a student from the queue. Used for /clear
     * ----
    */
    async removeAllStudents(): Promise<void> {
        await Promise.all(this.queueExtensions.map(
            extension => extension.onRemoveAllStudents(this.students))
        );
        this.students = [];
        await this.triggerRender();
    }

    /**
     * Adds a student to the notification group.
     * ----
     * Used for JoinNotif button
    */
    async addToNotifGroup(targetStudent: GuildMember): Promise<void> {
        if (this.notifGroup.has(targetStudent.id)) {
            return Promise.reject(new QueueError(
                'You are already in the notification squad.',
                this.name
            ));
        }
        this.notifGroup.set(targetStudent.id, targetStudent);
    }

    /**
     * Adds a student to the notification group.
     * ----
     * Used for RemoveNotif button
    */
    async removeFromNotifGroup(targetStudent: GuildMember): Promise<void> {
        if (!this.notifGroup.has(targetStudent.id)) {
            return Promise.reject(new QueueError(
                'You are not in the notification squad.',
                this.name
            ));
        }
        this.notifGroup.delete(targetStudent.id);
    }

    /**
     * Cleans up the #queue channel, removes every message then resend
     * ----
     * onQueueRenderComplete will be emitted
     * Very slow, non of the 3 promises can be parallelized
     * - because msg.delete must happen first
     * Will not be called unless QueueDisplay rejects a re-render
    */
    async cleanUpQueueChannel(): Promise<void> {
        const viewModel: QueueViewModel = {
            name: this.name,
            helperIDs: this.helpers.map(helper => `<@${helper.member.id}>`),
            studentDisplayNames: this.students.map(student => student.member.displayName),
            calendarString: '',
            isOpen: this.isOpen
        };
        await Promise.all((await this.queueChannel.channelObj.messages.fetch())
            .map(msg => msg.delete()));
        await this.display.renderQueue(viewModel, true);
        await Promise.all(this.queueExtensions.map(
            extension => extension.onQueueRenderComplete(this, this.display, true))
        );
    }

    /**
     * Re-renders the queue message.
     * ----
     * Composes the queue view model, then sends it to QueueDisplay
    */
    private async triggerRender(): Promise<void> {
        // build viewModel, then call display.render()
        const viewModel: QueueViewModel = {
            name: this.name,
            helperIDs: this.helpers.map(helper => `<@${helper.member.id}>`),
            studentDisplayNames: this.students.map(student => student.member.displayName),
            calendarString: '',
            isOpen: this.isOpen
        };
        await this.display.renderQueue(viewModel)
            .catch(async (err: QueueRenderError) => {
                console.error(`- Force rerender in ${err.queueName}.`);
                await this.cleanUpQueueChannel();
            });
        await Promise.all(this.queueExtensions.map(
            extension => extension.onQueueRenderComplete(this, this.display))
        ).catch(async (err: QueueRenderError) => {
            console.error(`- Force rerender in ${err.queueName}.`);
            await this.cleanUpQueueChannel();
        });
    }
}


export { HelpQueueV2, QueueViewModel };