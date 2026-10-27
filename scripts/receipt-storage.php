<?php
// Local CLI only. This worker writes only the dedicated receipt archive table.
declare(strict_types=1);
function respond(array $value, int $exitCode = 0): void {
    echo json_encode($value, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
    exit($exitCode);
}
function statusKey(array $row): string {
    // Keep formatting in the document; #00350 and #350 track the same receipt.
    return preg_match('/^[0-9]{1,20}$/D', $row['receipt_number'])
        ? 'number:' . (ltrim($row['receipt_number'], '0') ?: '0') : 'copy:' . $row['id'];
}
function summary(array $row): array {
    return ['id' => $row['id'], 'receiptNumber' => $row['receipt_number'],
        'recipientName' => $row['recipient_name'], 'receiptDate' => $row['receipt_date'] ?? '',
        'itemCount' => (int)$row['item_count'], 'total' => $row['total'],
        'createdAt' => str_replace(' ', 'T', $row['created_at']) . 'Z',
        'statusGroup' => statusKey($row), 'status' => $row['status'] ?? 'outstanding',
        'statusRevision' => (int)($row['status_revision'] ?? 0),
        'statusUpdatedAt' => isset($row['status_updated_at']) ? str_replace(' ', 'T', $row['status_updated_at']) . 'Z' : null];
}
$connected = false;
try {
    $request = json_decode(stream_get_contents(STDIN), true, 64, JSON_THROW_ON_ERROR);
    $config = $request['config'];
    if (!preg_match('/^[A-Za-z0-9_]+$/D', $config['database'] ?? '')) throw new RuntimeException('Invalid settings');
    $pdo = new PDO(sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $config['host'], $config['port'], $config['database']), $config['user'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => true, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_TIMEOUT => 5,
    ]);
    $connected = true;
    // Additive and repeatable; never alters the product catalog or existing records.
    $pdo->exec("CREATE TABLE IF NOT EXISTS `labeldesk_trust_receipts` (
        `id` CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        `content_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        `receipt_number` VARCHAR(20) NOT NULL,
        `recipient_name` VARCHAR(100) NOT NULL,
        `receipt_date` DATE NULL,
        `item_count` SMALLINT UNSIGNED NOT NULL,
        `total` DECIMAL(16,2) NOT NULL,
        `document_json` LONGTEXT NOT NULL,
        `created_at` DATETIME(6) NOT NULL,
        UNIQUE KEY `receipt_content` (`content_hash`),
        KEY `receipt_number` (`receipt_number`), KEY `receipt_date` (`receipt_date`),
        KEY `receipt_created` (`created_at`, `id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS `labeldesk_receipt_sequence` (
        `id` TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        `last_number` DECIMAL(20,0) NOT NULL
    ) ENGINE=InnoDB");
    $pdo->exec("CREATE TABLE IF NOT EXISTS `labeldesk_receipt_numbers` (
        `request_id` CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        `receipt_number` DECIMAL(20,0) NOT NULL UNIQUE
    ) ENGINE=InnoDB");
    $pdo->exec('INSERT IGNORE INTO `labeldesk_receipt_sequence` (`id`, `last_number`) VALUES (1, 0)');
    $pdo->exec("CREATE TABLE IF NOT EXISTS `labeldesk_receipt_statuses` (
        `receipt_key` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        `status` VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        `revision` INT UNSIGNED NOT NULL DEFAULT 0,
        `updated_at` DATETIME(6) NULL
    ) ENGINE=InnoDB");
    $statuses = ['outstanding', 'partially_returned', 'completed'];
    $statusColumns = "COALESCE(s.`status`, 'outstanding') AS `status`, COALESCE(s.`revision`, 0) AS `status_revision`, s.`updated_at` AS `status_updated_at`";
    $receiptFrom = " FROM `labeldesk_trust_receipts` r LEFT JOIN `labeldesk_receipt_statuses` s ON s.`receipt_key` = CASE WHEN r.`receipt_number` REGEXP '^[0-9]{1,20}$' THEN CONCAT('number:', CAST(CAST(r.`receipt_number` AS DECIMAL(20,0)) AS CHAR)) ELSE CONCAT('copy:', r.`id`) END";
    $fullSelect = "SELECT r.*, $statusColumns" . $receiptFrom;
    $action = $request['action'];
    if ($action === 'initialize') respond(['ready' => true]);
    if ($action === 'status') {
        $id = $request['id'] ?? ''; $status = $request['status'] ?? ''; $revision = $request['revision'] ?? null;
        if (!preg_match('/^[a-f0-9]{32}$/D', $id) || !in_array($status, $statuses, true) || !is_int($revision) || $revision < 0 || $revision >= 4294967295) respond(['error' => 'Invalid receipt status update.', 'status' => 400], 1);
        $pdo->beginTransaction();
        $find = $pdo->prepare('SELECT * FROM `labeldesk_trust_receipts` WHERE `id` = ?');
        $find->execute([$id]); $row = $find->fetch();
        if (!$row) { $pdo->rollBack(); respond(['error' => 'This saved receipt was not found.', 'status' => 404], 1); }
        $key = statusKey($row);
        $insert = $pdo->prepare("INSERT IGNORE INTO `labeldesk_receipt_statuses` (`receipt_key`, `status`, `revision`) VALUES (?, 'outstanding', 0)");
        $insert->execute([$key]);
        $find = $pdo->prepare('SELECT `status`, `revision` AS `status_revision`, `updated_at` AS `status_updated_at` FROM `labeldesk_receipt_statuses` WHERE `receipt_key` = ? FOR UPDATE');
        $find->execute([$key]); $current = $find->fetch();
        if ($current['status'] === $status) { $pdo->commit(); respond(['saved' => summary(array_merge($row, $current)), 'duplicate' => true]); }
        if ((int)$current['status_revision'] !== $revision) {
            $pdo->rollBack(); respond(['conflict' => true, 'saved' => summary(array_merge($row, $current))]);
        }
        $update = $pdo->prepare('UPDATE `labeldesk_receipt_statuses` SET `status` = ?, `revision` = `revision` + 1, `updated_at` = UTC_TIMESTAMP(6) WHERE `receipt_key` = ?');
        $update->execute([$status, $key]);
        $find->execute([$key]); $current = $find->fetch();
        $pdo->commit(); respond(['saved' => summary(array_merge($row, $current)), 'duplicate' => false]);
    }
    if ($action === 'number') {
        $id = $request['id'] ?? ''; $floor = $request['floor'] ?? '0';
        if (!preg_match('/^[a-f0-9]{32}$/D', $id) || !preg_match('/^[0-9]{1,20}$/D', $floor)) respond(['error' => 'Invalid receipt numbering request.', 'status' => 400], 1);
        $pdo->beginTransaction();
        $pdo->query('SELECT `last_number` FROM `labeldesk_receipt_sequence` WHERE `id` = 1 FOR UPDATE')->fetchColumn();
        $find = $pdo->prepare('SELECT `receipt_number` FROM `labeldesk_receipt_numbers` WHERE `request_id` = ?');
        $find->execute([$id]); $number = $find->fetchColumn();
        if ($number !== false) { $pdo->commit(); respond(['number' => $number]); }
        // DECIMAL arithmetic retains every digit above JavaScript/PHP integer limits.
        $next = $pdo->prepare('SELECT CAST(GREATEST(`last_number`, CAST(? AS DECIMAL(20,0)), (SELECT COALESCE(MAX(CAST(`receipt_number` AS DECIMAL(20,0))), 0) FROM `labeldesk_trust_receipts` WHERE `receipt_number` REGEXP \'^[0-9]{1,20}$\')) + 1 AS CHAR) FROM `labeldesk_receipt_sequence` WHERE `id` = 1');
        $next->execute([$floor]); $number = $next->fetchColumn();
        if (strlen($number) > 20) { $pdo->rollBack(); respond(['error' => 'The 20-digit receipt number limit has been reached. Enter a receipt number manually.', 'status' => 409], 1); }
        $insert = $pdo->prepare('INSERT INTO `labeldesk_receipt_numbers` (`request_id`, `receipt_number`) VALUES (?, ?)');
        $insert->execute([$id, $number]);
        $update = $pdo->prepare('UPDATE `labeldesk_receipt_sequence` SET `last_number` = ? WHERE `id` = 1');
        $update->execute([$number]);
        $pdo->commit(); respond(['number' => $number]);
    }
    if ($action === 'save') {
        $id = $request['id']; $hash = $request['hash']; $receipt = $request['receipt'];
        if (!preg_match('/^[a-f0-9]{32}$/D', $id) || !preg_match('/^[a-f0-9]{64}$/D', $hash)) respond(['error' => 'Invalid receipt save request.', 'status' => 400], 1);
        $details = $receipt['details'];
        $duplicate = false;
        // Serialize manual saves with allocation so the next number sees committed receipts.
        $pdo->beginTransaction();
        $pdo->query('SELECT `last_number` FROM `labeldesk_receipt_sequence` WHERE `id` = 1 FOR UPDATE')->fetchColumn();
        try {
            $insert = $pdo->prepare('INSERT INTO `labeldesk_trust_receipts` (`id`, `content_hash`, `receipt_number`, `recipient_name`, `receipt_date`, `item_count`, `total`, `document_json`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))');
            $insert->execute([$id, $hash, $details['receiptNumber'], $details['recipientName'], $details['receiptDate'] ?: null, count($receipt['items']), $receipt['total'], json_encode($receipt, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)]);
        } catch (PDOException $error) {
            if (($error->errorInfo[1] ?? null) !== 1062) throw $error;
            $duplicate = true;
        }
        // Unique keys make concurrent saves and retries safe without overwriting.
        $find = $pdo->prepare($fullSelect . ' WHERE r.`id` = ?');
        $find->execute([$id]); $row = $find->fetch();
        if ($row && $row['content_hash'] !== $hash) { $pdo->rollBack(); respond(['error' => 'This save request belongs to a different receipt. Refresh the saved list before trying again.', 'status' => 409], 1); }
        if (!$row) {
            $find = $pdo->prepare($fullSelect . ' WHERE r.`content_hash` = ?');
            $find->execute([$hash]); $row = $find->fetch();
        }
        if (!$row) throw new RuntimeException('Saved row missing');
        $pdo->commit();
        respond(['saved' => summary($row), 'duplicate' => $duplicate]);
    }
    if ($action === 'get') {
        if (!preg_match('/^[a-f0-9]{32}$/D', $request['id'] ?? '')) respond(['error' => 'Invalid saved receipt ID.', 'status' => 400], 1);
        $find = $pdo->prepare($fullSelect . ' WHERE r.`id` = ?');
        $find->execute([$request['id']]); $row = $find->fetch();
        if (!$row) respond(['error' => 'This saved receipt was not found.', 'status' => 404], 1);
        respond(['saved' => summary($row), 'receipt' => json_decode($row['document_json'], true, 64, JSON_THROW_ON_ERROR)]);
    }
    if ($action !== 'search') respond(['error' => 'Unknown receipt storage request.', 'status' => 400], 1);
    $query = $request['query']; $page = (int)$request['page']; $pageSize = (int)$request['pageSize']; $status = $request['status'] ?? '';
    if ($status !== '' && !in_array($status, $statuses, true)) respond(['error' => 'Invalid receipt status filter.', 'status' => 400], 1);
    if ($page < 1 || $page > 1000000 || $pageSize < 1 || $pageSize > 100 || mb_strlen($query, 'UTF-8') > 100) respond(['error' => 'Invalid receipt search.', 'status' => 400], 1);
    $where = ''; $values = [];
    if ($query !== '') {
        $where = " WHERE (r.`receipt_number` LIKE ? ESCAPE '=' OR r.`recipient_name` LIKE ? ESCAPE '=' OR CAST(r.`receipt_date` AS CHAR) LIKE ? ESCAPE '=')";
        $pattern = '%' . strtr(ltrim($query, '#'), ['=' => '==', '%' => '=%', '_' => '=_']) . '%';
        $values = [$pattern, $pattern, $pattern];
    }
    if ($status !== '') { $where .= ($where === '' ? ' WHERE ' : ' AND ') . "COALESCE(s.`status`, 'outstanding') = ?"; $values[] = $status; }
    $count = $pdo->prepare('SELECT COUNT(*)' . $receiptFrom . $where);
    $count->execute($values); $total = (int)$count->fetchColumn();
    $pages = (int)ceil($total / $pageSize); $page = min($page, max(1, $pages));
    $find = $pdo->prepare("SELECT r.`id`, r.`receipt_number`, r.`recipient_name`, r.`receipt_date`, r.`item_count`, r.`total`, r.`created_at`, $statusColumns" . $receiptFrom . $where . ' ORDER BY r.`created_at` DESC, r.`id` DESC LIMIT ? OFFSET ?');
    $parameter = 1;
    foreach ($values as $value) $find->bindValue($parameter++, $value, PDO::PARAM_STR);
    $find->bindValue($parameter++, $pageSize, PDO::PARAM_INT);
    $find->bindValue($parameter, ($page - 1) * $pageSize, PDO::PARAM_INT);
    $find->execute();
    respond(['receipts' => array_map('summary', $find->fetchAll()), 'total' => $total, 'page' => $page, 'totalPages' => $pages]);
} catch (Throwable $error) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    respond(['error' => $connected
        ? 'Cannot access saved receipts or numbering. Check the database account’s CREATE, SELECT, INSERT and UPDATE permissions for the Label Desk receipt tables on the PC.'
        : 'Cannot connect to saved receipts. Start MySQL in XAMPP and check data/catalog.json on the PC.', 'status' => 503], 1);
}
