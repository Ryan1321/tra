# Citizen mobile label printing

Choose a product from your local catalog, or enter **price, product name, SKU, and barcode** on your Android phone to update **Template 2 on the right**. Every print includes **Template 1's fixed artwork on the left**. Preview both stickers together and send them to the Citizen CL-S331 through Windows.

**One copy means one pair (two stickers).** Select 1–100 pairs per product. A batch can contain up to 50 items and 500 pairs in total.

## Start printing

1. On the Windows PC with the Citizen printer installed, double-click **Start Printing.cmd**. Node.js 22 or newer is required; this PC already has Node.js 24. There are no packages to install.
2. The dashboard opens at **http://localhost:4173/dashboard**. Choose **Print stickers** and confirm that the Citizen CL-S331 is selected. The printer must be powered on, have labels loaded, and work from Windows.
3. Connect Android to the same local network as this PC. Open the **phone address shown in setup** in Chrome and enter the six-digit pairing code displayed on the PC. Use the phone address, since `localhost` on the phone refers to the phone itself.
4. Start **MySQL** in the XAMPP Control Panel to use the product catalog. Browse the list or search by product name, SKU, or barcode, then tap **Select for label**. The four label fields fill from that product's current database record. You can also enter the fields manually.
5. Review the four fields and pair preview, choose copies, and tap **Print 1 pair** (or your selected number of pairs). Use **Open full-size preview** to inspect the artwork and barcode. Enter the peso amount, such as `199`; it prints automatically as `₱ 199.00`.

Keep the Windows PC awake and this service running. The launcher runs it in the background; **Stop Printing.cmd** stops it. Pairing is remembered by each browser. The pairing code changes when the service restarts; previously paired browsers remain connected.

## Dashboard

Open **Home** from any printing tool or visit **/dashboard**. The glass dashboard provides shortcuts to stickers, Trust Receipts, and waybills; today's submitted sticker pairs and document sheets; catalog product and saved receipt counts; the eight latest print jobs; and configured printers. On phones, recent activity and station details start collapsed. The existing sticker address **/** remains available.

Print activity refreshes every 15 seconds while the dashboard is visible. Database counts refresh separately every minute; the refresh button updates both. An unavailable database shows a dash rather than a misleading zero. Saved receipt counts include stored versions, not unique receipt numbers. Today's totals use the Windows PC's calendar day and retained history; **Sent** means Windows accepted the job, not confirmed physical output. Printer selections are configuration information, not live hardware health. Opening the dashboard never submits or retries a print job.

On the Windows PC, expand **Your station → Connect another phone** for the phone address and pairing code. Paired phones use the same dashboard without another setup step.

### Glass appearance and touch feedback

The dashboard and all three tools share an iPhone-inspired glass appearance, blue action buttons, a floating navigation dock, touch feedback, and a sliding selection pill in the mobile workspace tabs. Form inputs stay mounted when switching tabs. The screen styles live in `public/glass.css`; `public/liquid-glass.js` adds presentation effects without handling print requests or changing drafts. Reduced-motion settings disable movement, and reduced-transparency/high-contrast settings use opaque surfaces. Motion stops for print previews; the sticker artwork and document dimensions are unchanged.

## Product catalog

The service reads this PC's XAMPP database **`products`**, table **`products`**, at `127.0.0.1:3306`. Keep MySQL running while browsing or selecting products. Apache is not required: Node calls XAMPP's PHP command-line reader directly. Your phone connects to the printing service; database credentials stay on the PC.

- Browse all products, 25 per page, or search by any part of the name, SKU, or barcode. Use **Refresh** to fetch catalog changes.
- Select one product, review its label, and choose how many pairs to print. Selection fetches the current record and does not submit a print job.
- Products with missing details remain in the list and are marked. Fill the missing fields in the label editor before printing. Zero prices remain zero. Whitespace from imported names/SKUs is cleaned for labels.
- Edits in the label form affect only the label. Catalog queries are read-only; the service does not update product records. Separate rows with the same barcode remain separately selectable by database ID.
- If MySQL is stopped or unavailable, start it in XAMPP and use **Try again**. Manual label entry and printing remain available.

Connection settings are in **`data/catalog.json`** (see `catalog.example.json`). The defaults match this PC: `C:\\xampp\\php\\php.exe`, local MySQL port 3306, database/table `products`, user `root`, and an empty password. If your database password or location changes, update this private file on the PC. Settings are read on every catalog request, so no service restart is required. Never put database credentials in `public/`.

The table columns map as follows:

| Database column | Label field |
| --- | --- |
| `ProductName` | Product name |
| `ProductPrice` | Peso price |
| `ProductSKU` | SKU |
| `ProductCode` | Barcode |

`id` identifies each product row. The existing `ProductCode` column is an integer, so any leading zeros must already be stored in a text column to be retained by the database. Manually entered barcode strings preserve leading zeros.

## Batch printing

1. Tap **Add to batch** beside each catalog product you want to print. Keep searching or changing pages to add other products.
2. In the batch list, set the **copies** for each item. The total counts pairs: 3 pairs of one product and 2 of another produce 5 logo stickers and 5 product stickers.
3. Use **Edit** to review a queued item's label or fill missing details, then **Update batch item**. You can also enter a label manually and use **Add to batch** in the editor. Form edits affect the batch only when you save them to it.
4. Review the list and tap **Print batch**. The PC checks that every label fits before sending the first item, then sends each product in list order with its requested copies.

The draft list is saved in this browser. A submitted batch is saved on the PC and continues if the phone disconnects or you close the page. Reopen the same browser to recover its progress. Keep the PC, printing service, and printer running until submission finishes. Batch labels use the field values you reviewed when adding/editing them; later catalog changes do not alter a queued label.

Progress distinguishes **sent**, **uncertain**, and **not sent** items. If a submission fails, the service stops before sending later products. If the printing service restarts, unfinished batches are marked interrupted and do not resume automatically. Check the Windows print queue before starting a new batch after an uncertain result. A sent result means Windows accepted that item's job, not that the physical labels finished printing.

If the phone loses the submission response, it keeps the same batch request ID while checking the PC. Rechecking or sending the saved request does not repeat an existing batch. The last 200 batch records preserve this protection independently of single-label history. **Start a new batch** clears the completed list so you can prepare another print run; it does not cancel jobs already sent to Windows. If every item was rejected before submission, **Edit batch and try again** keeps the list so you can correct it. There is no automatic batch retry.

## Trust Receipt Agreement (TRA)

Open **TRA template** from the navigation, or go to **http://localhost:4173/tra** on the PC (use the PC's network address followed by `/tra` on your phone).

The new page copies the supplied **TRA Template.pdf** as a one-page **Letter, 8.5 × 11 inch** form. Its original wording, 20-row table, and signature lines are preserved in a vector template with embedded fonts. The supplied PDF is preserved at `reference/tra-original.pdf`.

Use **New receipt** to start a blank receipt with the next number, or leave the number blank and use **Save receipt to database** to assign it automatically. **Use next number** fills an empty number before printing without clearing the items. A manual number (for example, `00297`) is still accepted and prints as **#00297** in bold at the top left. Numbers are saved with the draft and sync to paired devices.

Enter the recipient details, then search the catalog by **product name, SKU, or barcode**. Select a product to fill its **description, barcode, and unit price**, enter the **quantity**, and tap **Add item**. Selection reads the latest product details and does not add a row until you choose its quantity. You can still type or correct the item fields manually. A missing SKU does not prevent use in a TRA because the form has no SKU column; missing description, barcode, or price must be completed before adding the item.

The document fills each row and calculates its amount and the total using exact cent arithmetic. Names, address, dates, and the total also fill the agreement's corresponding blanks. Signature lines remain blank for signing. You can edit or remove items; the draft stays in this browser. Once added, a row keeps the values you reviewed; later catalog price changes do not silently alter the receipt.

TRA catalog access shares the phone pairing used by sticker printing. An already paired browser connects automatically. If pairing is needed, enter the six-digit code shown on the Windows PC. On the PC, open `localhost` to connect automatically. Keep XAMPP **MySQL** running for catalog search. If it is unavailable, your receipt and manual item entry remain usable. Catalog selection is read-only and never edits the product database.

### Scan a barcode with your Android phone

1. On your phone's existing receipt page, tap **Enable live camera**. Complete the one-time certificate setup shown there, then tap **Open live scanning**. The app copies your pairing and saved receipt to the secure address; the original draft is retained. If the secure address already has a different receipt, you choose which one to continue.
2. On the secure receipt page, tap **Scan barcode** and allow camera access.
3. Point at one barcode. Detection is automatic: the camera closes as soon as it reads the code. A unique catalog match fills the item details and selects **Quantity**. If products share the barcode, choose the correct item.
4. Enter the quantity and tap **Add item**. Repeat for the next item. No shutter, photo confirmation, or area selection is needed.

The scanner automatically locates bars, corrects tilted views, and handles narrow printed margins. Camera frames stay on the phone; only the barcode value reaches the catalog. All decoder files come from the PC, so internet access is unnecessary. Matching preserves leading zeros. Unknown codes leave your receipt intact; replacing an unfinished item still requires confirmation. **Use a saved photo** is an optional alternative and also detects the barcode automatically.

Live camera access requires a trusted HTTPS connection ([browser camera requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)). The service supports both HTTP on port **4173** and HTTPS on **4175**, sharing the same catalog, pairing code, printer queue, and history. Bookmark the secure address shown during setup. The phone's certificate installation and first camera permission must be completed on the phone.

For a new PC installation, run `powershell.exe -ExecutionPolicy Bypass -File scripts/setup-camera-https.ps1`, then restart the printing service. This creates a local CA and server certificate under `data/tls`, using XAMPP OpenSSL. Only the public certificate is downloadable; private keys stay on the PC. The CA is limited to local/private addresses and is not installed into any device's trust store automatically. If the PC's network address changes or the server certificate expires, rerun that script and restart; it preserves the CA already installed on your phone. Certificate setup is available at `/camera-setup`. Decoder versions, hashes, and licenses are documented in `public/vendor/README.md`.

### Direct printing from the phone to the Epson

1. Keep **Start Printing.cmd** running on this Windows PC. Keep the Epson powered on with **Letter / short bond (8.5 × 11 inch)** paper loaded. If its Windows queue is shared from another PC, that PC must also stay on and reachable.
2. Open `/tra` on the paired phone. Fill the receipt and finish adding its items.
3. Under **Print through the Windows PC**, choose the Epson receipt printer, leave **Letter / short bond** selected, and enter **1–10 copies**.
4. Tap **Print on Epson**. The Windows service prepares the page and sends it to the Epson queue without opening a phone print dialog. **Sent to Windows** confirms submission to the queue; it does not confirm that paper has physically printed.

The installed Epson queue on this setup is `\\\\DESKTOP-BDOMOL4\\EPSON L120 Series`. It is selected automatically when it is the only matching Epson L120/L121 queue. Receipt and Citizen sticker printer settings are separate. Direct printing works on both the HTTP and HTTPS phone addresses; camera scanning still needs HTTPS.

The service uses the same fixed SVG artwork and text renderer as the preview, renders locally at 300 DPI using installed Edge or Chrome, then prints through the Windows driver. The form is enlarged by 6% around the page center to reduce its blank margins; adjust `RECEIPT_SCALE` in `public/tra-render.js` to tune this for the preview, PDF, and Epson together. It fits the full page inside the driver's printable area to avoid clipped edges. Letter is the default; A4 and long bond are also selectable if matching paper is loaded. No internet or cloud service is used to render the receipt.

Receipt requests have saved IDs in `data/receipt-jobs.json`. If the connection drops, tap **Check print status**; the same request is recovered without submitting duplicate copies. A restart or printer timeout can leave an uncertain result: check the Windows queue and paper output before choosing **Print another copy**. Do not delete print history to retry a job. Print history stores receipt number, total, and job metadata, not customer names or addresses.

**Print / Save PDF** remains available for the browser print dialog. Choose **Letter**, **100% scale**, and disable headers and footers. Text that will not fit is flagged before printing. One form supports up to **20 items**.

The `calculateReceipt(items)` boundary in `public/tra-model.js` accepts `{ quantity, description, barcode, unitPrice }` records. Catalog selection maps `ProductName` to description, `ProductCode` to barcode, and `ProductPrice` to unit price. Template geometry is documented in `reference/tra-layout.json`; the static copy is `public/tra-template.svg`. The shared preview/print renderer is `public/tra-render.js`; Windows document printing is in `scripts/receipt-worker.ps1`.

## Live syncing between phone and desktop

Open the same page on both paired devices: **Stickers**, **Trust Receipt**, or **Waybill**. Each page has one shared current draft on the printing PC. After refreshing both browsers, the **Live sync** banner shows when they are connected. Edits normally appear on the other device within about a second, without refreshing it.

- **Stickers:** product fields, copy quantity, catalog selections, and the editable batch list with each product's quantity.
- **Trust Receipt:** recipient details, unfinished item fields and quantity, plus added, edited or removed receipt rows and totals.
- **Waybill:** all fields in both halves of the sheet.

Changes work in both directions. Each page remains separate from the other two. Search text, camera activity, printer options and print buttons stay local to each device. Syncing a draft never starts printing. An existing print request keeps the snapshot it was submitted with; that device pauses syncing until its pending request is resolved. A sticker batch also pauses syncing on the submitting device until **Start a new batch** or **Edit batch and try again**.

Drafts are retained locally and shared through `data/shared-drafts.json` on the PC, using the same pairing and HTTP/HTTPS service as printing. The file contains the current document content, including receipt names and addresses, and should stay private with the other files in `data`. Keep the PC and service running and both devices on the same local network.

Offline edits stay on the device and merge after reconnecting. Different fields merge automatically. If the same field or item list changed on both devices, **Compare changes** shows both versions; choose **Use shared changes** or **Keep my changes**. The same choice protects an older browser draft when it first joins a different shared draft. The previous local/shared versions are backed up in that browser's `labeldesk.sync.<page>.v1.recovery` storage entry when you choose. Nothing is silently printed or resubmitted during recovery.

## Editable waybills

Open **Waybill** in the app navigation, or visit **http://localhost:4173/waybill** on the PC. On the phone, use your existing printing-service address followed by `/waybill`.

The page follows `Waybill - sample.docx`: **two independently editable waybills on one Letter / short bond sheet**, with a large number, red destination, and bold centered delivery details. The original Word reference is preserved at `reference/waybill-original.docx`.

1. Enter each waybill's **number, destination / branch, bus / courier, terminal / location, recipient name, and contact number**. Number, destination, recipient and contact number are required for both halves before printing; bus and terminal are optional.
2. **Copy details to waybill 2** copies the first form and suggests the next numeric number, preserving leading zeros. You can then edit either half separately. For numbers containing letters, enter the second number manually.
3. Review the live preview. Text shrinks to fit within readable limits; text that is still too long is flagged before printing. **Load reference example** fills the sample details from the supplied Word file.
4. Choose **Print on Epson** for direct printing through the PC, or **Print / Save PDF** for the browser dialog. Each copy is one Letter sheet containing both waybills; direct printing supports 1–10 copies. The destination prints red when the selected Windows driver supports color. Browser printing should use Letter, 100% scale and no headers or footers.

Waybill drafts save automatically in this browser, separately from Trust Receipt drafts. An already paired phone connects automatically; otherwise enter the PC's pairing code in the Waybill page. The Epson selection is shared with Trust Receipts, while the Citizen sticker selection remains separate. The service allows one document submission at a time.

Print requests use `data/waybill-jobs.json` for duplicate prevention and restart recovery. History contains waybill numbers and print metadata, without recipient names or contact details. Interrupted requests can be recovered with **Check print status**. An uncertain result requires checking the Windows queue before starting another request; it is never automatically printed again. **Sent to Windows** confirms queue submission, not physical paper output.

The form is in `public/waybill.html` and `public/waybill.js`; field validation is in `public/waybill-model.js`. Adjust text positions and font sizes in `public/waybill-render.js`, which is shared by the preview and direct printer renderer. The server accepts field values only and creates the page locally using Edge or Chrome. No Word installation is needed to print waybills.

## Your two-template sticker pair

Use **Sticker size** above the product catalog to choose a variation before printing:

- **1.5 × 1 in each — original pair:** a **3 × 1 inch** row at **900 × 300 dots**.
- **1.25 × 1 in each — compact pair:** a **2.5 × 1 inch** row at **750 × 300 dots**. The fixed logo is on the left; peso price, SKU, product name and barcode are on the right. The logo keeps its proportions, and price/SKU use separate lines to fit the narrower sticker.

Sizes are **width × height**. Load matching two-column stock in the Citizen. Each copy still prints one logo sticker and one product sticker. The chosen size applies to the whole batch, is saved with the draft, and syncs to your other paired device. A pending print request retains its original size, including after reload. Existing drafts and requests default to the original size.

The compact layout reserves the same 12-dot outer margins as the original, with two **363 × 300 dot** artwork areas starting at x=12 and x=375. Its barcode uses the largest uniform whole-dot bars that fit this narrower area; the existing `+5` total padding remains in place. Long values that cannot fit legibly are rejected before printing. Layout presets are in `public/label-layouts.js`; drawing/font positions are in `scripts/label-worker.ps1`.

### Original pair reference

- The original BarTender file and Citizen driver confirm a **3 × 1 inch page**, **two columns**, and **one row** at **300 dpi**. Each template is **1.461 × 1 inch**, with **0.039 inch left and right outer margins** and no horizontal gap.
- The service renders the whole row as **900 × 300 dots**. Rounded to whole printer dots, Template 1 starts at x=12 and Template 2 at x=450; each is 438 × 300 dots. The layout is recorded in `reference/layout.json` and `lib/validation.js`.
- **Template 1, left:** the Lapekto Lapel logo, food-safe artwork, and website from the original file's embedded artwork preview. These are fixed and receive no product-field values.
- **Template 2, right:** peso price at the top left, SKU at the top right, product name centered (up to two lines), and a Code 128 barcode with its readable value below. Every price includes `₱`, comma grouping, and two decimal places. SKU and barcode are separate inputs. Leading zeros are preserved.
- The original `.btw` is unchanged. The service renders the pair through the Windows driver; it does not write product values into the original BarTender document. In that document, the named `ProductName` source is attached to a picture, so the service keeps its editable product name independent of that source.
- Text that cannot fit legibly is rejected. Code 128 uses the **largest uniform whole-dot bar width** that fits the full 438-dot right sticker. Per your chosen `+5` setting, it reserves **5 modules of white padding in total**, split between the sides (2.5 modules each, rounded to whole dots when needed). The encoder and printer use the same padding. For `100650`, the barcode plus padding fills all 438 dots. These reduced margins need a test scan on the actual printed sticker. Up to 32 numeric digits or 16 printable ASCII characters can fit the bars; readable text must also fit.
- Printing uses the installed Windows driver. It does not require BarTender, printer emulation changes, Android printer drivers, or an internet service.

Set matching two-column label stock, gap sensing, orientation, and media type in the Citizen driver's **Printing Preferences**. The service requests the selected full row size (**3 × 1 inches** or **2.5 × 1 inches**) at 300 dpi with no scaling, and checks both stickers against the driver's printable area. Copies repeat the whole row, so 3 copies produce 3 logo stickers and 3 product stickers. Print and scan one pair first to confirm stock alignment and scan quality. **Sent to printer** means Windows accepted the submission; it does not confirm that the stickers emerged.

Sticker printing reuses the validated preview image. Batches retain their prepared images through submission, and changing copy counts does not render the label again. For multiple copies of a product, the worker checks the driver's copy limit and sends one page with the requested quantity when supported. Drivers with a lower limit use the original repeated-page method, preserving the exact quantity. This applies to both the single-product Print button and each product in a batch; batch order and duplicate-request protection stay the same. See [Windows driver copy limits](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.printing.printersettings.copies).

The worker reads the shared driver's printable area once per job and checks page dimensions and DPI on every submitted page. Pixel-bound checking uses `scripts/label-native.cs`; the label image is unchanged. New sticker job records include preparation, driver-check and submission timings, plus `copyPlan` (`DriverCopies`, `PagesToSend`, `Mode`), to help distinguish service delays from Windows queue or printer delays. A 20-pair job on the Citizen should show 20 driver copies and one submitted page.

## If the phone cannot connect

Use the address shown in the PC setup page; it can change after a router restart. The phone and PC must be on the same network, with guest/client isolation disabled for these devices. If Windows asks about Node.js network access, allow it on your private network.

If Windows Firewall blocks access, run `scripts/allow-phone-access.ps1` from an Administrator PowerShell. It allows Node.js on TCP ports **4173 and 4175**, restricted to the local subnet and Windows Private networks. Keep this service on your local network; do not forward its ports through your router. Use the secure address for live scanning.

## If a label does not print

Confirm the selected printer in setup and inspect its Windows print queue. The saved template references `\\192.168.1.202\Citizen CL-S331`; Windows currently lists that printer. If it is hosted by another PC, that PC must also remain available. The service works with a locally installed USB Citizen queue as well.

If a request times out or the result is uncertain, check the Windows queue before submitting another job. Repeating the same request ID will not create a second submission among the 200 saved jobs. A service restart during printing leaves that job marked as uncertain for review. Print jobs are not automatically retried.

After checking the printer and queue, use **Start a new print request** if you need a fresh submission of the same pair. This clears the pending request without printing; then tap **Print 1 pair** when ready. History from the earlier single-label version retains its original quantities.

## Files and maintenance

- `public/`: mobile interface; no external fonts or scripts.
- `server.js`, `lib/`: local HTTP service, pairing, validation, barcode encoding, Windows bridge.
- `scripts/label-worker.ps1`: paired PNG rendering and Windows driver printing.
- `lib/catalog.js`, `scripts/catalog.php`: authenticated catalog search/detail access through PHP PDO prepared queries. PHP requires `pdo_mysql` and `mbstring`, already enabled in this PC's XAMPP installation.
- `data/catalog.json`: private catalog connection settings; `catalog.example.json`: sample settings.
- `data/config.json`: pairing credential and chosen printer; `data/jobs.json`: last 200 job records. Keep these private. The latest 12 jobs appear in the interface.
- `lib/batch.js`: batch quantity and label validation. `data/batches.json`: last 200 batches, including their per-item results and duplicate protection; do not remove it to retry a batch.
- `data/server.log`, `data/server-error.log`: launcher logs.
- `reference/template-preview-1.png`: fixed left-hand artwork extracted from the supplied template; required for printing. `reference/original-layout.btw` is a preserved source copy, and `reference/layout.json` records verified layout measurements.

To forget paired devices, stop the service, remove `data/config.json`, and start it again. To clear saved job history, stop the service and remove `data/jobs.json`. Stop the service before moving this project.

Run `npm test` for automated checks, `npm run check` for JavaScript syntax, or `npm start` to run in the foreground. To use another port, set `PORT` before launching; update the firewall rule to match. Do not run multiple instances against the same `data` directory.

Verification: automated tests cover TRA amount calculations and row limits, batch validation, order, quantities, duplicate prevention, failure handling and restart recovery, plus catalog search, authentication, barcode sizing, peso formatting, paired layout, and legacy history. Mobile TRA catalog checks covered search, pagination, fresh details, quantity entry, duplicate barcodes, zero prices, incomplete records, saved drafts, canceled requests, deleted products, pairing, and manual entry during a database outage. Browser checks confirmed that blank and fully populated 20-row TRA documents each export as one Letter page, with no clipping or script errors. Mobile checks also exercised batch editing, invalid-price recovery, draft restoration and reload during submission using a mock printer. A pixel comparison confirmed that changing all four sticker fields changes only the right sticker. The Citizen driver's 3 × 1 inch, 300 dpi preflight passed without submitting a print job.

### Saved Trust Receipts in MySQL

On `/tra`, use **Save receipt to database** after entering the recipient's name and adding at least one item. A blank receipt number is assigned automatically; dates remain optional. Finish adding or editing an item before saving. Saving is separate from printing.

Open **Find a saved receipt** and search by receipt number, recipient name, or receipt date (`YYYY-MM-DD`). **Open receipt** loads the complete copy into the current shared draft, ready to edit or print with the existing Epson/PDF buttons. Opening asks before replacing the draft on paired devices and keeps the previous local draft in `labeldesk.tra.before-open.v1` browser storage.

Saved copies preserve names, addresses, dates, item descriptions, barcode text (including leading zeros), quantities, original unit prices and calculated totals. Later catalog price changes do not change them. Saving an edited receipt creates a new copy; identical numbered content is stored once, including retries after an interrupted connection. Earlier copies are never overwritten. Reopening or editing a copy keeps its original receipt number.

Storage uses the existing private `data/catalog.json` XAMPP MySQL connection. The service creates **`labeldesk_trust_receipts`**, **`labeldesk_receipt_sequence`**, **`labeldesk_receipt_numbers`**, and **`labeldesk_receipt_statuses`** automatically; the product table remains read-only. The database account needs CREATE, SELECT and INSERT permissions for these tables, plus UPDATE for the sequence and status tables. Keep MySQL running. An outage leaves the browser draft intact; retry when MySQL is available. The saved list works from paired phones and PCs and refreshes when opened or searched.

Automatic numbers continue above the highest saved, previously printed, current shared draft, or already reserved number (starting at 1 when all are empty). Allocation uses a database transaction so simultaneous requests receive different numbers. Interrupted requests retry with the same ID, including after a browser reload. The browser records that ID in `labeldesk.tra.number.pending.v1`. Numbers are reserved before editing/printing; abandoning a receipt may leave a gap. Reserved numbers are never recycled. New receipt clears the current draft only after numbering succeeds; typing during the request leaves the edited draft intact. Manual overrides are allowed, and saved versions may intentionally share a number. If two people change the shared draft at once, use the existing live-sync conflict controls to choose the intended document.

Include all four receipt tables in database backups: unlike the current draft, archived receipts, statuses and the numbering sequence are stored in MySQL, not in `data/shared-drafts.json`. The receipt table contains customer details. The API requires the existing device pairing; database credentials stay on the PC. Implementation: `lib/receipt-storage.js`, `scripts/receipt-storage.php`, `public/tra-saved.js`, and `public/tra-numbering.js`.

### Trust Receipt status

Under **Find a saved receipt**, each saved copy shows its current status:

- **Outstanding:** still awaiting completion.
- **Partially returned:** some items have been returned and the receipt remains open.
- **Completed:** the receipt is resolved.

Choose a value under **Change status** and tap **Update status**. The change applies to every saved copy with that receipt number, including copies saved later. Leading zeros affect display only: `00350` and `350` share a status. Legacy unnumbered copies are tracked separately. Existing receipts start as Outstanding until you change them; no past completion is inferred. Manual numbers reused for different transactions will also share status, so use a distinct number for each transaction.

The **Receipt status** filter works together with the number/name/date search. While the list is open, visible and idle, it refreshes about every five seconds. A pending status choice is preserved until you update it or search again. If another device changes the same status first, the app shows the latest value and asks you to choose again. Retrying an update that already succeeded does not create another change or reset its timestamp.

Status is manual progress tracking. It does not change item quantities, prices, totals, inventory, the current draft, or the printed template. Saved receipt content and print history remain unchanged. Statuses live in `labeldesk_receipt_statuses`, keyed by receipt number; updates use a database transaction and revision checks to protect simultaneous edits.

### Printer references

[Citizen CL-S321 / CL-S331 manual](https://www.citizen-systems.co.jp/cms/c-s/en/printer/download/document-user-label/PXZ00089-30_UM_EN_CL-S321_331_L.pdf) documents 300 dpi for CL-S331, Windows drivers, interfaces, and media setup. [Citizen ZPL command reference](https://www.citizen-systems.com/resource/support/Label/Manuals/Command_Reference/Citizen_ZPL_Command_Ref.pdf) illustrates why this service uses the installed driver instead of assuming a printer command language.
