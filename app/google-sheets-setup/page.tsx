import type { Metadata } from "next";
import { CopyButton } from "@/components/copy-button";

export const metadata: Metadata = { title: "Google Sheets setup · Blitz Lead Engine" };

const CODE = `function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // one write at a time so rows never overwrite each other
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var row = JSON.parse(e.postData.contents).row;
    var lastCol = sheet.getLastColumn();
    var headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    var missing = Object.keys(row).filter(function (k) { return headers.indexOf(k) === -1; });
    if (missing.length) {
      headers = headers.concat(missing);
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    sheet.appendRow(headers.map(function (h) { return row[h] === undefined ? "" : row[h]; }));
    return ContentService.createTextOutput("ok");
  } finally {
    lock.releaseLock();
  }
}`;

export default function GoogleSheetsSetup() {
  return (
    <div className="doc">
      <h1>Send rows to a Google Sheet (one-time setup, about 2 minutes)</h1>
      <ol>
        <li>Create a new Google Sheet (or open the one you want the leads in).</li>
        <li>In the sheet, click <b>Extensions → Apps Script</b>.</li>
        <li>Delete everything in the editor and paste the code below, then click <b>Save</b>.</li>
        <li>Click <b>Deploy → New deployment</b>. Pick the type <b>Web app</b> (gear icon).<br />
          Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>. Click <b>Deploy</b> and allow the permissions.</li>
        <li>Copy the <b>Web app URL</b> (it ends in <code>/exec</code>) and paste it into the
          <b> Apps Script URL</b> box of the &quot;Send to Google Sheet&quot; step.</li>
      </ol>
      <p className="muted">The first row of the sheet becomes the column headers automatically. New columns are added on the right as new kinds of data appear.
        Anyone with the URL can add rows to this sheet, so keep the URL private.</p>
      <pre>{CODE}</pre>
      <CopyButton text={CODE} />
    </div>
  );
}
