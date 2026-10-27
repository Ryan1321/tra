<?php
// Local CLI worker. Reads catalog data only; not an Apache/public web endpoint.
declare(strict_types=1);

function respond(array $value, int $exitCode = 0): void {
    echo json_encode($value, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR);
    exit($exitCode);
}

function labelText($value): string {
    // Catalog imports sometimes leave line endings in SKU/name fields.
    // Normalize display whitespace without changing the database record.
    return trim(preg_replace('/[\x00-\x20\x7F]+/u', ' ', (string)$value) ?? '');
}

function product(array $row): array {
    return [
        'id' => (string)$row['id'],
        'productName' => labelText($row['ProductName']),
        'price' => trim((string)$row['ProductPrice']),
        'sku' => labelText($row['ProductSKU']),
        'barcode' => trim((string)$row['ProductCode']),
    ];
}

$connected = false;
try {
    $request = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
    $config = $request['config'];
    if (!is_array($config) || !preg_match('/^[A-Za-z0-9_]+$/D', $config['database'] ?? '') || !preg_match('/^[A-Za-z0-9_]+$/D', $config['table'] ?? '')) {
        respond(['error' => 'Invalid catalog settings on the PC.', 'status' => 503], 1);
    }
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $config['host'], $config['port'], $config['database']);
    $pdo = new PDO($dsn, $config['user'], $config['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => true,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    $connected = true;
    $table = '`' . $config['table'] . '`';
    $columns = '`id`, `ProductName`, `ProductPrice`, `ProductSKU`, `ProductCode`';

    if ($request['action'] === 'barcode') {
        $value = $request['value'] ?? null;
        if (!is_string($value) || $value === '' || mb_strlen($value, 'UTF-8') > 100 || $value !== trim($value) || preg_match('/[\x00-\x1F\x7F]/', $value)) {
            respond(['error' => 'Invalid catalog barcode.', 'status' => 400], 1);
        }
        // Compare the stored text byte-for-byte: numeric columns must not make
        // "00123" match "123", and text columns must not ignore case or spaces.
        $where = ' WHERE CAST(CAST(`ProductCode` AS CHAR) AS BINARY) = CAST(? AS BINARY)';
        $count = $pdo->prepare("SELECT COUNT(*) FROM $table$where");
        $count->bindValue(1, $value, PDO::PARAM_STR);
        $count->execute();
        $total = (int)$count->fetchColumn();
        $statement = $pdo->prepare("SELECT $columns FROM $table$where ORDER BY (TRIM(`ProductName`) = ''), `ProductName`, `id` LIMIT 100");
        $statement->bindValue(1, $value, PDO::PARAM_STR);
        $statement->execute();
        $products = [];
        while ($row = $statement->fetch()) $products[] = product($row);
        respond(['products' => $products, 'total' => $total]);
    }

    if ($request['action'] === 'product') {
        $id = (string)($request['id'] ?? '');
        if (!preg_match('/^[1-9][0-9]{0,9}$/D', $id) || (int)$id > 2147483647) respond(['error' => 'Invalid product ID.', 'status' => 400], 1);
        $statement = $pdo->prepare("SELECT $columns FROM $table WHERE `id` = ? LIMIT 1");
        $statement->bindValue(1, (int)$id, PDO::PARAM_INT);
        $statement->execute();
        $row = $statement->fetch();
        if (!$row) respond(['error' => 'This product is no longer in the catalog. Refresh the list.', 'status' => 404], 1);
        respond(['product' => product($row)]);
    }

    if ($request['action'] !== 'search') respond(['error' => 'Unknown catalog request.', 'status' => 400], 1);
    $query = (string)($request['query'] ?? '');
    $page = (int)($request['page'] ?? 1);
    $pageSize = (int)($request['pageSize'] ?? 25);
    if ($page < 1 || $page > 1000000 || $pageSize < 1 || $pageSize > 100 || mb_strlen($query, 'UTF-8') > 100) respond(['error' => 'Invalid catalog search.', 'status' => 400], 1);
    $where = '';
    $searchValues = [];
    if ($query !== '') {
        $where = " WHERE (`ProductName` LIKE ? ESCAPE '=' OR `ProductSKU` LIKE ? ESCAPE '=' OR CAST(`ProductCode` AS CHAR) LIKE ? ESCAPE '=')";
        $pattern = '%' . strtr($query, ['=' => '==', '%' => '=%', '_' => '=_']) . '%';
        $searchValues = [$pattern, $pattern, $pattern];
    }

    $count = $pdo->prepare("SELECT COUNT(*) FROM $table$where");
    $count->execute($searchValues);
    $total = (int)$count->fetchColumn();
    $totalPages = (int)ceil($total / $pageSize);
    $page = min($page, max(1, $totalPages));
    $statement = $pdo->prepare("SELECT $columns FROM $table$where ORDER BY (TRIM(`ProductName`) = ''), `ProductName`, `id` LIMIT ? OFFSET ?");
    $parameter = 1;
    foreach ($searchValues as $value) $statement->bindValue($parameter++, $value, PDO::PARAM_STR);
    $statement->bindValue($parameter++, $pageSize, PDO::PARAM_INT);
    $statement->bindValue($parameter, ($page - 1) * $pageSize, PDO::PARAM_INT);
    $statement->execute();
    $products = [];
    while ($row = $statement->fetch()) $products[] = product($row);
    respond(['products' => $products, 'total' => $total, 'page' => $page, 'pageSize' => $pageSize, 'totalPages' => $totalPages]);
} catch (PDOException $error) {
    respond(['error' => $connected
        ? 'The product catalog could not be read. Check its table and column settings on the PC.'
        : 'Cannot connect to the product catalog. Start MySQL in XAMPP and check data/catalog.json on the PC.', 'status' => 503], 1);
} catch (Throwable $error) {
    respond(['error' => 'The catalog reader could not complete the request. Check XAMPP PHP and catalog settings on the PC.', 'status' => 503], 1);
}
