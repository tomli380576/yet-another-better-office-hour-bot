import { GoogleSpreadsheet } from 'google-spreadsheet';
import { ExpectedSheetErrors } from './google-sheet-constants/expected-sheet-errors.js';
import { environment } from '../../environment/environment-manager.js';
import { LOGGER } from '../../global-states.js';

const GOOGLE_SHEET_LOGGER = LOGGER.child({ extension: 'Google Sheet' });

/**
 * Loads a google sheet object by sheet id
 * @param sheetId id found in the url
 */
async function loadSheetById(sheetId: string): Promise<GoogleSpreadsheet> {
    const googleSheet = new GoogleSpreadsheet(sheetId);
    await googleSheet.useServiceAccountAuth(environment.googleCloudCredentials);
    await googleSheet.loadInfo().catch(err => {
        GOOGLE_SHEET_LOGGER.error(err, `bad id ${sheetId}`);
        throw ExpectedSheetErrors.badGoogleSheetId;
    });
    return googleSheet;
}

export { loadSheetById, GOOGLE_SHEET_LOGGER };
