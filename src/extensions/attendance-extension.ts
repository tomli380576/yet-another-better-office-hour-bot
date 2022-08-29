import { GoogleSpreadsheet } from "google-spreadsheet";
import { Helper } from "../models/member-states";
import { BaseServerExtension } from "./base-interface";
import gcs_creds from "../../gcs_service_account_key.json";

class AttendanceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AttendanceError";
    }
    briefErrorString(): string {
        return `**${this.name}**: ${this.message}`;
    }
}

class AttendanceExtension extends BaseServerExtension {

    constructor(
        private serverName: string,
        private attendanceDoc: GoogleSpreadsheet
    ) {
        super();
    }

    static async load(serverName: string): Promise<AttendanceExtension> {
        if (process.env.YABOB_GOOGLE_SHEET_ID !== undefined ||
            gcs_creds === undefined) {
            const attendanceDoc = new GoogleSpreadsheet(process.env.YABOB_GOOGLE_SHEET_ID);
            await attendanceDoc.useServiceAccountAuth(gcs_creds);
            console.log(`[\x1b[33mAttendance Extension\x1b[0m] successfully loaded for ${serverName}!`);
            return new AttendanceExtension(serverName, attendanceDoc);
        }
        return Promise.reject(
            new Error('No google sheet ID or GCS credentials found. Please check the .env file.')
        );
    }

    override async onHelperStopHelping(
        helper: Readonly<Required<Helper>>
    ): Promise<void> {
        await this.updateAttendance(helper)
            .catch(() => Promise.reject(
                new AttendanceError(
                    `Failed to update attendace.\n` +
                    `Don't worry, your time is still being logged, just not viewable on Google Sheets. ` +
                    `Please contact an hooman to manually update.`
                )
            ));
    }

    private async updateAttendance(
        helper: Readonly<Required<Helper>>
    ): Promise<void> {
        await this.attendanceDoc.loadInfo();

        // try to find existing sheet
        // if not created, make a new one
        let sheetForThisServer = this.attendanceDoc.sheetsByTitle[this.serverName];
        if (sheetForThisServer === undefined) {
            sheetForThisServer = await this.attendanceDoc.addSheet({
                title: this.serverName,
                headerValues: [
                    "Username",
                    "Time In",
                    "Time Out",
                    "Helped Students",
                ],
            });
        }

        await sheetForThisServer.addRow({
            "Username": helper.member.user.username,
            "Time In": `${helper.helpStart.toLocaleDateString()} ` +
                `${helper.helpStart.toLocaleTimeString()}`,
            "Time Out": `${helper.helpEnd.toLocaleDateString()} ` +
                `${helper.helpEnd.toLocaleTimeString()}`,
            "Helped Students": JSON.stringify(
                helper.helpedMembers.map(student => new Object({
                    nickName: student.nickname,
                    username: student.user.username
                }))),
        });
    }

}


export { AttendanceExtension };